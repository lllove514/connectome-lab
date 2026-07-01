"""Build docs/connectome.json from the C. elegans hermaphrodite connectome.

Source data is the Cook et al. (2019) whole-animal connectome, downloaded as
CSV from the Netzschleuder mirror of the Emmons Lab / WormWiring release. Each
network (chemical, gap junction) comes as its own zipped pair of nodes.csv and
edges.csv. We keep only neurons (dropping muscle and end-organ nodes for v1),
split the chemical (directed) and gap-junction (undirected) graphs, tag every
neuron as sensory / inter / motor, and precompute a 2D spring layout so the
browser can draw the graph without running any physics itself.

Re-runnable: the two raw zips are cached under data/raw/ (gitignored) and only
re-fetched when missing or corrupt, so repeated runs neither hit the network
nor change their output. The layout uses a fixed seed for the same reason.

Run with --selftest to exercise the pure functions offline (no network).
"""

import csv
import io
import json
import math
import os
import random
import re
import sys
import zipfile
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
OUT = os.path.join(HERE, os.pardir, "docs", "connectome.json")

CHEMICAL_URL = "https://networks.skewed.de/net/celegans_2019/files/hermaphrodite_chemical.csv.zip"
GAP_URL = "https://networks.skewed.de/net/celegans_2019/files/hermaphrodite_gap_junction.csv.zip"

# The dataset carries anatomical type on each node, so the role split normally
# comes straight from it. This public OpenWorm table is only a fallback for when
# that ever stops giving a clean split; it is best-effort and we degrade to
# "unknown" if it is unreachable rather than crashing.
OPENWORM_TYPES_URL = "https://raw.githubusercontent.com/openworm/c302/master/c302/data/CElegansNeuronTables.csv"

LAYOUT_ITERATIONS = 300
LAYOUT_SEED = 1729  # fixed so the layout — and the committed JSON — reproduce exactly

# Some genuine neurons are filed by location or sex rather than by role, grouped
# in with the muscle, gland, marginal and glial cells they sit near, so node_type
# alone can't recover them: the 20 pharyngeal neurons (Albertson & Thomson 1976),
# the hermaphrodite-specific HSN and VC motor neurons, and the two CAN neurons.
# C. elegans cell names are lineage-fixed, so we rescue this exact set by name.
EXTRA_NEURONS = frozenset({
    "I1L", "I1R", "I2L", "I2R", "I3", "I4", "I5", "I6",
    "M1", "M2L", "M2R", "M3L", "M3R", "M4", "M5", "MCL", "MCR", "MI", "NSML", "NSMR",
    "HSNL", "HSNR", "VC01", "VC02", "VC03", "VC04", "VC05", "VC06",
    "CANL", "CANR",
})


def die(msg):
    print("error:", msg, file=sys.stderr)
    sys.exit(1)


def download(url):
    """Return the local path to the cached zip, fetching it once if absent."""
    path = os.path.join(RAW, url.rsplit("/", 1)[-1])
    if os.path.exists(path) and zipfile.is_zipfile(path):
        return path
    import requests  # only needed on a real download; cached runs stay dependency-free

    print("downloading", os.path.basename(path))
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    with open(path, "wb") as fh:
        fh.write(resp.content)
    if not zipfile.is_zipfile(path):
        die("downloaded file is not a valid zip: " + url)
    return path


def norm(cell):
    """Header cells arrive as e.g. '# source' or 'Node_Type'; flatten them."""
    return cell.strip().lstrip("#").strip().lower()


def find_col(header, wanted, contains=False):
    for i, cell in enumerate(header):
        name = norm(cell)
        if (wanted in name) if contains else (name == wanted):
            return i
    return None


def require_col(header, wanted, where):
    i = find_col(header, wanted)
    if i is None:
        i = find_col(header, wanted, contains=True)
    if i is None:
        die("no '%s' column in %s header: %s" % (wanted, where, header))
    return i


def coerce_weight(text):
    text = text.strip()
    try:
        return int(text)
    except ValueError:
        try:
            return float(text)
        except ValueError:
            return 1


def read_csv_member(zf, keyword):
    """Return (header, rows) for the CSV in the zip whose name contains keyword."""
    names = [n for n in zf.namelist() if keyword in n.lower() and n.lower().endswith(".csv")]
    if not names:
        return None, None
    with zf.open(names[0]) as raw:
        rows = list(csv.reader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")))
    if not rows:
        return None, None
    return rows[0], rows[1:]


def read_network(zip_path, label):
    """Parse one network zip into ({name: (type, subtype)}, [(src, tgt, weight)]).

    Edges reference nodes either by integer row index or by name; we detect which
    from the first edge and map everything back to names so the two networks can
    be merged on a shared node identity.
    """
    with zipfile.ZipFile(zip_path) as zf:
        node_hdr, node_rows = read_csv_member(zf, "node")
        edge_hdr, edge_rows = read_csv_member(zf, "edge")
    if edge_hdr is None or not edge_rows:
        die("no usable edges CSV inside " + os.path.basename(zip_path))
    print("\n[%s] node header: %s" % (label, node_hdr))
    print("[%s] edge header: %s" % (label, edge_hdr))

    attrs = {}
    index_to_name = {}
    if node_hdr is not None:
        i_name = require_col(node_hdr, "name", label + " nodes")
        i_type = find_col(node_hdr, "node_type") or find_col(node_hdr, "type", contains=True)
        i_sub = find_col(node_hdr, "node_subtype") or find_col(node_hdr, "subtype", contains=True)
        i_index = find_col(node_hdr, "index")
        for pos, row in enumerate(node_rows):
            name = row[i_name].strip()
            key = int(row[i_index]) if i_index is not None and row[i_index].strip().isdigit() else pos
            index_to_name[key] = name
            attrs[name] = (
                row[i_type].strip() if i_type is not None else "",
                row[i_sub].strip() if i_sub is not None else "",
            )

    i_src = require_col(edge_hdr, "source", label + " edges")
    i_tgt = require_col(edge_hdr, "target", label + " edges")
    i_w = find_col(edge_hdr, "connectivity")
    if i_w is None:
        i_w = find_col(edge_hdr, "weight") or find_col(edge_hdr, "value")
    if i_w is None:
        print("[%s] warning: no 'connectivity' weight column; defaulting weights to 1" % label)

    by_index = edge_rows[0][i_src].strip().lstrip("-").isdigit()

    def to_name(value):
        value = value.strip()
        return index_to_name.get(int(value)) if by_index else value

    edges = []
    for row in edge_rows:
        s, t = to_name(row[i_src]), to_name(row[i_tgt])
        if not s or not t:
            continue
        edges.append((s, t, coerce_weight(row[i_w]) if i_w is not None else 1))
    return attrs, edges


def classify(node_type, node_subtype):
    """Map a node's type fields to (is_neuron, role).

    Membership is decided mainly by node_type — the neuron buckets are
    'SENSORY NEURONS', 'INTERNEURONS' and 'MOTOR NEURONS'. node_subtype must NOT
    add neurons: body-wall muscles, end organs and sex-specific cells carry a
    subtype of 'BODY MOTOR NEURONS' (the neurons that drive them), so folding it
    in would misfile ~130 non-neurons as motor neurons. It can only REMOVE them:
    a handful of cells (e.g. the head mesodermal cell hmc) are typed
    'MOTOR NEURONS' yet flagged an end organ or muscle in the subtype, and those
    are not neurons. Role is the anatomical prefix of node_type, falling back to
    node_subtype for a confirmed neuron.
    """
    sub = node_subtype.lower()
    is_neuron = "neuron" in node_type.lower() and "end organ" not in sub and "muscle" not in sub
    role = "unknown"
    for text in (node_type.lower(), sub):
        for keyword in ("sensory", "inter", "motor"):
            if keyword in text:
                role = keyword
                break
        if role != "unknown":
            break
    return is_neuron, role


# Body-wall muscle names look like dBWML1: d/v is dorsal/ventral, L/R is the
# left/right row, the number is the position from head (1) to tail.
MUSCLE_RE = re.compile(r"^([dv])BWM([LR])(\d+)$")


def is_muscle(node_type):
    """True for a body-wall muscle cell, keyed off node_type the same careful way
    neuron membership is. Body-wall muscles carry node_type 'BODYWALL MUSCLES';
    the pharyngeal muscles (node_type 'PHARYNX') and the sex-specific muscles
    (node_type 'SEX-SPECIFIC CELLS', with 'MUSCLES' only in the subtype) are
    deliberately excluded, so this stays the 95-cell body-wall set.
    """
    t = node_type.lower()
    return "bodywall" in t and "muscle" in t


def muscle_meta(name):
    """Parse a body-wall muscle name into (side, row, position), or None."""
    m = MUSCLE_RE.match(name)
    if not m:
        return None
    side = "dorsal" if m.group(1) == "d" else "ventral"
    row = "left" if m.group(2) == "L" else "right"
    return side, row, int(m.group(3))


def rescued_role(name):
    """Role for a name-rescued neuron, following its lineage naming convention.

    Pharyngeal I1-I6 are interneurons; the pharyngeal M/MC/MI/NSM cells and the
    hermaphrodite HSN and VC cells are motor neurons. CAN has no chemical
    synapses and no accepted sensory/inter/motor role, so it stays 'unknown'.
    """
    if name in ("CANL", "CANR"):
        return "unknown"
    return "inter" if name.startswith("I") else "motor"


def neuron_class(name):
    """Approximate the anatomical class by stripping the positional suffix.

    C. elegans neurons are named class + position: the bilateral pair ADAL/ADAR
    both belong to class ADA, the fourfold IL1DL/IL1DR/IL1VL/IL1VR to class IL1.
    We peel a trailing L/R (left/right) then a trailing D/V (dorsal/ventral).
    ponytail: numbered members like VA1..VA12 stay distinct and a handful of
    unpaired cells (AVL) over-strip; good enough for v1 grouping, revisit with a
    real class table if the UI ever leans on it.
    """
    c = name
    if c[-1:] in ("L", "R"):
        c = c[:-1]
    if c[-1:] in ("D", "V"):
        c = c[:-1]
    return c or name


def fetch_openworm_types():
    """Best-effort {neuron: role} map from a public table; {} if unreachable."""
    import requests

    try:
        resp = requests.get(OPENWORM_TYPES_URL, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as exc:
        print("warning: could not fetch OpenWorm classification table:", exc)
        return {}
    rows = list(csv.reader(io.StringIO(resp.text)))
    if not rows:
        return {}
    header = rows[0]
    i_name = find_col(header, "neuron") or find_col(header, "name", contains=True)
    i_type = find_col(header, "type", contains=True)
    if i_name is None or i_type is None:
        print("warning: OpenWorm table columns not recognized:", header)
        return {}
    out = {}
    for row in rows[1:]:
        if len(row) <= max(i_name, i_type):
            continue
        out[row[i_name].strip()] = classify("", row[i_type])[1]
    return out


def normalize(pos):
    """Scale positions into a padded 0..1 box, rounded for clean git diffs."""
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    minx, spanx = min(xs), (max(xs) - min(xs)) or 1.0
    miny, spany = min(ys), (max(ys) - min(ys)) or 1.0
    pad = 0.02
    scale = 1.0 - 2 * pad
    return {
        v: (round(pad + scale * (x - minx) / spanx, 5), round(pad + scale * (y - miny) / spany, 5))
        for v, (x, y) in pos.items()
    }


def spring_layout(node_ids, edges, iterations, seed):
    """Fruchterman-Reingold force-directed layout in pure Python.

    Every node repels every other (like charges) while edges pull their
    endpoints together (like springs). A 'temperature' caps each step and cools
    to zero so the system settles instead of oscillating. Deterministic given
    the seed, so committed positions don't churn between runs.
    """
    rng = random.Random(seed)
    ids = list(node_ids)
    n = len(ids)
    if n == 0:
        return {}
    if n == 1:
        return {ids[0]: (0.5, 0.5)}
    pos = {v: [rng.random(), rng.random()] for v in ids}
    k = math.sqrt(1.0 / n)  # ideal edge length on a unit square
    pairs = {(s, t) for s, t, _ in edges if s in pos and t in pos and s != t}
    temp = 0.1
    cooling = temp / (iterations + 1)
    for _ in range(iterations):
        disp = {v: [0.0, 0.0] for v in ids}
        # Repulsion is O(n^2). ponytail: fine for ~300 neurons; swap in a grid or
        # Barnes-Hut approximation only if the node set ever grows past a few thousand.
        for a in range(n):
            va = ids[a]
            ax, ay = pos[va]
            for b in range(a + 1, n):
                vb = ids[b]
                dx, dy = ax - pos[vb][0], ay - pos[vb][1]
                dist2 = dx * dx + dy * dy
                if dist2 == 0.0:
                    dx, dy = rng.uniform(-1e-3, 1e-3), rng.uniform(-1e-3, 1e-3)
                    dist2 = dx * dx + dy * dy
                dist = math.sqrt(dist2)
                force = k * k / dist
                ux, uy = dx / dist * force, dy / dist * force
                disp[va][0] += ux
                disp[va][1] += uy
                disp[vb][0] -= ux
                disp[vb][1] -= uy
        for s, t in pairs:
            dx, dy = pos[s][0] - pos[t][0], pos[s][1] - pos[t][1]
            dist = math.hypot(dx, dy) or 1e-9
            force = dist * dist / k
            ux, uy = dx / dist * force, dy / dist * force
            disp[s][0] -= ux
            disp[s][1] -= uy
            disp[t][0] += ux
            disp[t][1] += uy
        for v in ids:
            dx, dy = disp[v]
            dist = math.hypot(dx, dy) or 1e-9
            step = min(dist, temp)
            pos[v][0] += dx / dist * step
            pos[v][1] += dy / dist * step
        temp -= cooling
    return normalize(pos)


def aggregate(edges, neurons, undirected):
    """Keep neuron-to-neuron edges, sum parallel ones, drop self-loops.

    ponytail: gap-junction rows are assumed listed once per junction; if the
    source ever lists both directions this sums them into one symmetric weight.
    """
    totals = {}
    for s, t, w in edges:
        if s not in neurons or t not in neurons or s == t:
            continue
        key = tuple(sorted((s, t))) if undirected else (s, t)
        totals[key] = totals.get(key, 0) + w
    out = [{"source": a, "target": b, "weight": w} for (a, b), w in totals.items()]
    out.sort(key=lambda e: (e["source"], e["target"]))
    return out


def main():
    os.makedirs(RAW, exist_ok=True)
    chem_zip = download(CHEMICAL_URL)
    gap_zip = download(GAP_URL)

    attrs_c, edges_c = read_network(chem_zip, "chemical")
    attrs_g, edges_g = read_network(gap_zip, "gap")
    node_attrs = dict(attrs_g)
    node_attrs.update(attrs_c)  # chemical zip wins on the rare conflict

    print("\nnode (type | subtype) values seen:")
    for ntype, nsub in sorted(set(node_attrs.values())):
        print("   %s | %s" % (ntype, nsub))

    neurons = {}
    for name, (ntype, nsub) in node_attrs.items():
        is_neuron, role = classify(ntype, nsub)
        if not is_neuron and name in EXTRA_NEURONS:
            is_neuron, role = True, rescued_role(name)
        if is_neuron:
            neurons[name] = {"id": name, "name": name, "type": role, "class": neuron_class(name)}

    # C. elegans has ~300 neurons; a much smaller count means the type fields
    # are not what we assumed, so stop rather than write a garbage dataset.
    if len(neurons) < 100:
        die("only %d neurons detected — check the node type columns above" % len(neurons))

    classification_source = (
        "dataset node_type/node_subtype (Cook et al. 2019); pharyngeal, HSN, VC and "
        "CAN neurons rescued by name from the location and sex-specific buckets"
    )
    unresolved = [n for n, d in neurons.items() if d["type"] == "unknown"]
    if len(unresolved) > 0.2 * len(neurons):
        table = fetch_openworm_types()
        if table:
            filled = 0
            for name in unresolved:
                role = table.get(name)
                if role and role != "unknown":
                    neurons[name]["type"] = role
                    filled += 1
            classification_source = "dataset fields + OpenWorm table (%d filled)" % filled
        else:
            print("warning: %d neurons left as 'unknown' (no external table reachable)" % len(unresolved))

    chemical = aggregate(edges_c, neurons, undirected=False)
    gap = aggregate(edges_g, neurons, undirected=True)

    # Muscle / output layer, kept entirely separate from the neuron graph above:
    # the body-wall muscles and the neuromuscular junctions that drive them. The
    # neuron nodes/chemical/gap sections are untouched. The chemical zip lists each
    # junction muscle-first (muscle, neuron), so we flip it to the biological
    # neuron -> muscle direction.
    muscle_names = sorted(name for name, (ntype, _sub) in node_attrs.items() if is_muscle(ntype))
    if not (80 <= len(muscle_names) <= 110):
        die("detected %d body-wall muscles, expected ~95 — check the muscle type column" % len(muscle_names))
    muscle_set = set(muscle_names)
    muscles_out = []
    for name in muscle_names:
        parsed = muscle_meta(name)
        side, row, pos = parsed if parsed else ("unknown", "unknown", 0)
        muscles_out.append({"id": name, "name": name, "side": side, "row": row, "pos": pos})

    nmj_totals = {}
    for s, t, w in edges_c:
        if s in muscle_set and t in neurons:  # file order is (muscle, neuron)
            nmj_totals[(t, s)] = nmj_totals.get((t, s), 0) + w  # keyed neuron -> muscle
    neuromuscular = [{"source": neu, "target": mus, "weight": w} for (neu, mus), w in nmj_totals.items()]
    neuromuscular.sort(key=lambda e: (e["source"], e["target"]))

    layout = spring_layout(sorted(neurons), edges_c + edges_g, LAYOUT_ITERATIONS, LAYOUT_SEED)
    nodes_out = []
    for name in sorted(neurons):
        x, y = layout[name]
        nodes_out.append({**neurons[name], "x": x, "y": y})

    by_type = {"sensory": 0, "inter": 0, "motor": 0, "unknown": 0}
    for node in nodes_out:
        by_type[node["type"]] += 1

    meta = {
        "source": "Cook et al. 2019 C. elegans hermaphrodite connectome "
                  "(Emmons Lab / WormWiring), via the Netzschleuder mirror",
        "source_url": "https://networks.skewed.de/net/celegans_2019",
        "retrieved_date": date.fromtimestamp(os.path.getmtime(chem_zip)).isoformat(),
        "classification_source": classification_source,
        "counts": {
            "neurons": len(nodes_out),
            "chemical": len(chemical),
            "gap": len(gap),
            "by_type": by_type,
            "muscles": len(muscles_out),
            "neuromuscular": len(neuromuscular),
        },
    }

    data = {
        "nodes": nodes_out,
        "chemical": chemical,
        "gap": gap,
        "muscles": muscles_out,
        "neuromuscular": neuromuscular,
        "meta": meta,
    }
    with open(OUT, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")

    print("\nneurons: %d   chemical: %d   gap: %d" % (len(nodes_out), len(chemical), len(gap)))
    print("by type:", by_type)
    print("muscles: %d   neuromuscular junctions: %d" % (len(muscles_out), len(neuromuscular)))
    print("wrote", os.path.relpath(OUT, HERE))


def selftest():
    assert classify("SENSORY NEURONS", "") == (True, "sensory")
    assert classify("INTERNEURONS", "") == (True, "inter")
    assert classify("MOTOR NEURONS", "BODY MOTOR NEURONS") == (True, "motor")
    # Muscles, end organs and sex cells borrow 'BODY MOTOR NEURONS' as their
    # subtype; membership keys off node_type so they must stay out of the graph.
    assert classify("BODYWALL MUSCLES", "BODY MOTOR NEURONS")[0] is False
    assert classify("OTHER END ORGANS", "BODY MOTOR NEURONS")[0] is False
    # hmc is typed 'MOTOR NEURONS' but flagged an end organ by its subtype.
    assert classify("MOTOR NEURONS", "OTHER END ORGANS")[0] is False
    assert classify("PHARYNX", "") == (False, "unknown")
    assert len(EXTRA_NEURONS) == 30
    assert rescued_role("I3") == "inter"
    assert rescued_role("M4") == "motor"
    assert rescued_role("NSML") == "motor"
    assert rescued_role("HSNL") == "motor"
    assert rescued_role("VC03") == "motor"
    assert rescued_role("CANL") == "unknown"
    assert neuron_class("ADAL") == "ADA"
    assert neuron_class("RMED") == "RME"
    assert neuron_class("IL1VL") == "IL1"
    # Muscle layer: body-wall muscles are detected by node_type, and only those.
    assert is_muscle("BODYWALL MUSCLES") is True
    assert is_muscle("MOTOR NEURONS") is False
    assert is_muscle("SEX-SPECIFIC CELLS") is False  # sex muscles carry 'MUSCLES' in the subtype only
    assert is_muscle("PHARYNX") is False
    assert muscle_meta("dBWML1") == ("dorsal", "left", 1)
    assert muscle_meta("vBWMR24") == ("ventral", "right", 24)
    assert muscle_meta("AVAL") is None
    a = spring_layout(["a", "b", "c"], [("a", "b", 1), ("b", "c", 1)], 50, LAYOUT_SEED)
    b = spring_layout(["a", "b", "c"], [("a", "b", 1), ("b", "c", 1)], 50, LAYOUT_SEED)
    assert a == b, "layout must be deterministic for a fixed seed"
    assert all(0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 for x, y in a.values())
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()

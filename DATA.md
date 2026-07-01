## Source

Cook, S.J., Jarrell, T.A., Brittin, C.A., et al. "Whole-animal connectomes of
both Caenorhabditis elegans sexes." Nature 571, 63–71 (2019).
doi:10.1038/s41586-019-1352-7

Origin and owner: the Emmons Lab, Albert Einstein College of Medicine, published
via WormWiring (https://wormwiring.org). Downloaded as CSV from the Netzschleuder
network repository mirror (https://networks.skewed.de/net/celegans_2019), files
`hermaphrodite_chemical.csv.zip` and `hermaphrodite_gap_junction.csv.zip`.

Retrieved: 2026-06-30.

## Processing

`data/build_connectome.py` keeps only neurons (muscle, gland, glial and
end-organ nodes are dropped), separates the chemical (directed) and gap-junction
(undirected) networks, tags each neuron sensory / inter / motor, and precomputes
a Fruchterman-Reingold layout. Output: `docs/connectome.json` — 302 neurons.

Neuron classification: membership and role come from the dataset's own
`node_type` field (Cook et al. 2019); `node_subtype` is deliberately excluded
because muscles and end organs carry the subtype `BODY MOTOR NEURONS` (their
innervation) and would otherwise be misfiled as motor neurons. The 20 pharyngeal
neurons, the hermaphrodite-specific HSN and VC neurons, and the two CAN neurons
are filed by the source under location/sex buckets rather than by role, so they
are rescued by name from their lineage-fixed identities. CAN has no chemical
synapses and no accepted role, so it is left `unknown`.

## Teaching layer

The guided circuits (`docs/circuits.json`) and the glossary in `docs/teach.js`
are curated from WormAtlas (https://www.wormatlas.org) and the C. elegans
literature. Each circuit's neuron memberships and narration are drawn from the
published descriptions of these behaviors, not from the connectivity data:

- Gentle touch reflex and tap withdrawal: the ALM/AVM/PLM/PVM touch receptor
  neurons, the AVA/AVB/AVD/PVC command interneurons, and representative VA/DA/
  VB/DB motor neurons (Chalfie et al.; Wicks and Rankin, on the tap response).
- Chemotaxis: the AWA/AWC/ASE amphid sensory neurons into the AIA/AIB/AIY/AIZ
  and RIA interneuron layer (WormAtlas; the C. elegans chemotaxis literature).
- Egg laying: the serotonergic HSN neurons and the VC motor neurons (WormAtlas;
  the egg-laying circuit literature). The vulval muscles they drive are not
  neurons and are not in this dataset.

Any named neuron not present in `docs/connectome.json` is skipped by the app
rather than renamed or invented. Memberships are a teaching simplification, not
a claim about every synapse in the data.

## License and reuse

No explicit open-data license (no CC BY or CC0) is stated by the source; the data
is used here under academic citation. Netzschleuder's own AGPLv3 covers their
software, not the network data it hosts.

Raw files are not redistributed — `data/raw/` is gitignored. Only the transformed
`docs/connectome.json` is committed, with the attribution above. Use here is
non-commercial and educational.

For commercial reuse, contact the Emmons Lab; this project is a non-commercial demo.

## Credits

- Connectome data: Cook et al. 2019 / Emmons Lab / WormWiring, via Netzschleuder.
- Circuit memberships and glossary: WormAtlas (https://www.wormatlas.org).

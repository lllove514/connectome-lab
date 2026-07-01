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

The guided touch-reflex circuit (`docs/circuits.json`) and the glossary in
`docs/teach.js` are curated from WormAtlas (https://www.wormatlas.org) and the
C. elegans touch-circuit literature (Chalfie et al.; the gentle-touch reflex).
Neuron memberships (ALM/AVM/PLM touch cells, the AVA/AVB/AVD/PVC command
interneurons, and representative VA/DA/VB/DB motor neurons) follow the
WormAtlas neuron descriptions.

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

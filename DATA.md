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

`data/build_connectome.py` keeps only neurons (muscle and end-organ nodes are
dropped for v1), separates the chemical (directed) and gap-junction (undirected)
networks, tags each neuron sensory / inter / motor, and precomputes a
Fruchterman-Reingold layout. Output: `web/connectome.json`.

Neuron classification: derived from the dataset's own `node_type` / `node_subtype`
fields (Cook et al. 2019). If those fields fail to give a clean split the script
falls back to the OpenWorm CElegansNeuronTables; any neuron still unresolved is
left as `unknown`.

## License and reuse

No explicit open-data license (no CC BY or CC0) is stated by the source; the data
is used here under academic citation. Netzschleuder's own AGPLv3 covers their
software, not the network data it hosts.

Raw files are not redistributed — `data/raw/` is gitignored. Only the transformed
`web/connectome.json` is committed, with the attribution above. Use here is
non-commercial and educational.

For commercial reuse, contact the Emmons Lab; this project is a non-commercial demo.

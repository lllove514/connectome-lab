"""Build the connectome dataset used by the web viewer.

Fetches and reshapes neuron connectivity into the JSON the front-end reads.
Re-runnable and idempotent: running it again overwrites outputs in place.
"""

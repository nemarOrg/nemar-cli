# /// script
# requires-python = ">=3.11"
# dependencies = ["bagel==0.11.6"]
# ///
"""Print what the pinned Neurobagel `bagel` release says about the graph models.

The vocabulary generator (generate-vocab.ts) runs this through `uv run` so the
JSON-LD `@context` and the two JSON Schemas it commits come from Neurobagel's
own pydantic models, never from a hand copy.
The `bagel` pin above must move together with PINS.bagel in generate-vocab.ts.

Output: one JSON object on stdout with keys `bagel_version`, `context`,
`dataset_schema` (JSON Schema of `bagel.models.Dataset`, the shape graph-mode
JSON-LD must validate against once `@context` is removed) and
`dictionary_schema` (the data dictionary schema `bagel pheno` validates with).
"""

import json
from importlib.metadata import version

from bagel import models
from bagel.utilities import model_utils, pheno_utils


def main() -> None:
    out = {
        "bagel_version": version("bagel"),
        "context": model_utils.generate_context("Neurobagel")["@context"],
        "dataset_schema": models.Dataset.model_json_schema(),
        "dictionary_schema": pheno_utils.construct_dictionary_schema_for_validation(),
    }
    print(json.dumps(out, sort_keys=True))


if __name__ == "__main__":
    main()

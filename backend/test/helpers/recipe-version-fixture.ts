/**
 * The image `test/fixtures/nemar-recipe-version.json` describes: the CUDA image of nemar-process v0.1.2, the one
 * `COMPUTE_RUNTIME_IMAGE` pins for every recipe. Its digest-pinned reference and its `sha256:` digest.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CUDA_REF = (
  JSON.parse(
    readFileSync(join(import.meta.dir, "../../../test/fixtures/nemar-recipe-version.json"), "utf8"),
  ) as { image: string }
).image;

export const CUDA_DIGEST = CUDA_REF.slice(CUDA_REF.indexOf("@") + 1);

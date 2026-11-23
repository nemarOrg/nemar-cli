/**
 * The local launch specification, `nemar.local-launch.v1` (ADR 0134 decision 8, epic #2324 phase 6):
 * the file a person hands the launcher's standalone entry (`nemar-launch-local --spec FILE`) to run one
 * job on their own machine, with no NEMAR service involved.
 *
 * THE JSON SCHEMA NEXT TO THIS FILE (`compute-local-launch.schema.json`) IS COPIED BYTE FOR BYTE BY
 * `nemarOrg/nemar-process` (`launcher/schema/compute-local-launch.v1.json`), whose launcher parses the
 * file. `test/compute-local-launch-contract.unit.test.ts` holds the two to each other.
 *
 * It is the launch specification (`./compute-launch.ts`) without what only NEMAR's service gives: no
 * `job_id`, `api_base`, `job_token` or `limits`, and no NEMAR `datasets`. What runs, and how, is the
 * same: `runtime`, `entry`, `command`, `args`, `bundle`, `image`, `env` and `resources` are the launch
 * specification's own members, with its rules (exactly one of `entry` and `command`; an `entry` comes
 * with the `bundle` that holds it; the image file and the image reference are the ones the image
 * digest names). A test holds those members of the two JSON Schemas equal, value for value.
 *
 * It adds a required `format` word and `datasets` as names only: the person binds each name to a
 * directory on their own machine on the command line (`--data NAME=DIR`), never in this file, so the
 * file holds no host path. Because each document has a key the other refuses (`format` here, `job_id`
 * there), a launch specification and a local one can never be taken for each other.
 *
 * The text is read under the launch specification's own encoding rules: printable ASCII JSON, at most
 * {@link LOCAL_LAUNCH_MAX_BYTES} bytes, no duplicate keys, no fractions. Its digest is the SHA-256 of
 * the file's bytes.
 *
 * It is closed (`.strict()`) at every level: a mistyped key is a bug to refuse. Like
 * `./compute-launch.ts`, this file is exempted by name in `test/contract-schemas.test.ts`.
 *
 * Nothing here reads a clock, a database or a network.
 */

import { z } from "zod";
import { LAUNCH_SPEC_MAX_BYTES, LaunchSpecSchema, sifFileNameForDigest } from "./compute-launch.js";
import { COMPUTE_IMAGE_REF_RE } from "./compute.js";

/** The format word every local launch specification carries; a later version is refused by name. */
export const LOCAL_LAUNCH_FORMAT = "nemar.local-launch.v1";

/** The largest local launch specification, in bytes: the launch specification's own bound. */
export const LOCAL_LAUNCH_MAX_BYTES = LAUNCH_SPEC_MAX_BYTES;

/** The most datasets one local job names: the launch specification's own bound. */
export const LOCAL_LAUNCH_MAX_DATASETS = 20;

/**
 * A dataset's name: the directory under `/data` the job reads it from, and the `NAME` of
 * `--data NAME=DIR`. A letter or digit, then up to 63 letters, digits, `.`, `_` or `-`.
 */
export const LOCAL_DATASET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The members a local job shares with the launch specification, taken from it, not copied. */
const shared = LaunchSpecSchema.innerType().pick({
  runtime: true,
  entry: true,
  command: true,
  args: true,
  bundle: true,
  image: true,
  env: true,
  resources: true,
}).shape;

/** One dataset a local job reads: its name only. */
export const LocalLaunchDatasetSchema = z
  .object({ name: z.string().regex(LOCAL_DATASET_NAME_RE) })
  .strict();

/**
 * The local launch specification. Every key but `entry`, `command` and `bundle` is required, as in the
 * launch specification. No unknown key is accepted, at any level.
 */
export const LocalLaunchSpecSchema = z
  .object({
    format: z.literal(LOCAL_LAUNCH_FORMAT),
    ...shared,
    datasets: z.array(LocalLaunchDatasetSchema).max(LOCAL_LAUNCH_MAX_DATASETS),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const refuse = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    if ((spec.entry === undefined) === (spec.command === undefined)) {
      refuse(["entry"], "exactly one of entry and command");
    }
    if (spec.entry !== undefined && spec.bundle === undefined) {
      refuse(["bundle"], "an entry needs the bundle that holds it");
    }
    const seen = new Set<string>();
    spec.datasets.forEach((d, i) => {
      if (seen.has(d.name)) refuse(["datasets", i, "name"], "a dataset name is given twice");
      seen.add(d.name);
    });
    // The image rules of the launch specification, each only when both its fields are well formed.
    const named = sifFileNameForDigest(spec.image.digest);
    if (named !== null && /^[0-9a-f]{64}\.sif$/.test(spec.image.sif) && spec.image.sif !== named) {
      refuse(["image", "sif"], "the image file is not the one named for the image digest");
    }
    if (
      named !== null &&
      COMPUTE_IMAGE_REF_RE.test(spec.image.uri) &&
      !spec.image.uri.endsWith(spec.image.digest)
    ) {
      refuse(["image", "uri"], "the image reference is not pinned to the image digest");
    }
  });

export type LocalLaunchDataset = z.infer<typeof LocalLaunchDatasetSchema>;
export type LocalLaunchSpec = z.infer<typeof LocalLaunchSpecSchema>;

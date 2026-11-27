/**
 * The recipe's progress file, `nemar.recipe-progress.v1` (ADR 0134 decisions 3 and 8, epic #2324
 * phase 6): what a job writes at `$NEMAR_OUT/.nemar-progress/progress.json` while it runs, and what the
 * launcher reads from outside the container to build the live progress object
 * (`./compute-progress.ts`) and, in standalone mode, the results report
 * (`./compute-results-report.ts`). nemar-process's shared recipe layer writes it; a third party who
 * wants progress for their own job writes the same file.
 *
 * THE JSON SCHEMA NEXT TO THIS FILE (`compute-recipe-progress.schema.json`) IS COPIED BYTE FOR BYTE BY
 * `nemarOrg/nemar-process` (`launcher/schema/compute-recipe-progress.v1.json`). Together with the
 * encoding rules below, it describes exactly what the launcher's reader (`check_recipe_progress`)
 * accepts: `test/compute-recipe-progress-contract.unit.test.ts` replays a corpus whose verdicts that
 * reader gave, including files the recipe layer itself wrote.
 *
 * The text is read under encoding rules no schema can state: UTF-8 JSON with no duplicate key, no
 * `NaN`, `Infinity` or `-Infinity`, and every integer written without a fraction (`1`, never `1.0`).
 *
 * The file holds the recipe and its checkpoint map, where the recordings table is (relative to
 * `NEMAR_OUT`), how many recordings the run discovered (every one gets exactly one table row) and the
 * recording that is running with its current step. It holds no samples and no host path. The file is at
 * most {@link RECIPE_PROGRESS_MAX_BYTES} bytes; the launcher reads it without following a link.
 *
 * Rules no schema can state: a checkpoint is named once, and a step is in one checkpoint only (the
 * zod schema enforces both). It is closed at every level. Like `./compute-progress.ts`, this file is
 * exempted by name in `test/contract-schemas.test.ts`.
 *
 * Nothing here reads a clock, a database or a network.
 */

import { z } from "zod";
import {
  PROGRESS_CHECKPOINT_RE,
  PROGRESS_MAX_CHECKPOINTS,
  PROGRESS_MAX_RECORDINGS,
  PROGRESS_STEP_RE,
} from "./compute-progress.js";

/** The format word of the recipe's progress file; a later version is refused by name. */
export const RECIPE_PROGRESS_FORMAT = "nemar.recipe-progress.v1";

/** The directory under `NEMAR_OUT` that holds the file. */
export const RECIPE_PROGRESS_DIRECTORY = ".nemar-progress";

/** The file's name in that directory. */
export const RECIPE_PROGRESS_FILE = "progress.json";

/** The largest file the launcher reads, in bytes. */
export const RECIPE_PROGRESS_MAX_BYTES = 65_536;

/** The checkpoint only the backend sets; a recipe never declares it. */
export const RECIPE_PROGRESS_STORED = "stored";

/** The most steps one checkpoint maps. */
export const RECIPE_PROGRESS_MAX_STEPS = 64;

/** The longest running recording's path, in characters (code points). */
export const RECIPE_PROGRESS_RUNNING_PATH_MAX = 4096;

/** A recipe id: a lowercase letter or digit, then up to 63 lowercase letters, digits or hyphens. */
export const RECIPE_PROGRESS_RECIPE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A recipe version: 1 to 64 letters, digits, `.`, `+` or `-`. */
export const RECIPE_PROGRESS_VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;

/**
 * The recordings table, relative to `NEMAR_OUT`: 1 to 8 `/`-separated parts, each a letter or digit
 * then up to 127 letters, digits, `.`, `_` or `-`, the last ending in `_recordings.tsv`.
 */
export const RECIPE_PROGRESS_TABLE_RE =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/){0,7}[A-Za-z0-9][A-Za-z0-9._-]{0,112}_recordings\.tsv$/;

/** One checkpoint and the steps that count at it, in order. */
export const RecipeCheckpointMapItemSchema = z
  .object({
    checkpoint: z
      .string()
      .regex(PROGRESS_CHECKPOINT_RE)
      .refine((c) => c !== RECIPE_PROGRESS_STORED, "stored is set by the backend"),
    steps: z.array(z.string().regex(PROGRESS_STEP_RE)).min(1).max(RECIPE_PROGRESS_MAX_STEPS),
  })
  .strict();

/** A recipe's checkpoint map: each checkpoint named once, each step in one checkpoint only. */
export const RecipeCheckpointMapSchema = z
  .array(RecipeCheckpointMapItemSchema)
  .min(1)
  .max(PROGRESS_MAX_CHECKPOINTS)
  .superRefine((map, ctx) => {
    const names = new Set<string>();
    const steps = new Set<string>();
    map.forEach((item, i) => {
      if (names.has(item.checkpoint)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "checkpoint"],
          message: "a checkpoint is named once",
        });
      }
      names.add(item.checkpoint);
      item.steps.forEach((step, j) => {
        if (steps.has(step)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "steps", j],
            message: "a step is in one checkpoint only",
          });
        }
        steps.add(step);
      });
    });
  });

/** The recording that is running, and the step it is in (null until its first step starts). */
export const RecipeProgressRunningSchema = z
  .object({
    path: z
      .string()
      .refine(
        (p) => [...p].length <= RECIPE_PROGRESS_RUNNING_PATH_MAX,
        `at most ${RECIPE_PROGRESS_RUNNING_PATH_MAX} characters`,
      ),
    step: z.string().regex(PROGRESS_STEP_RE).nullable(),
  })
  .strict();

/** The recipe's progress file. */
export const RecipeProgressSchema = z
  .object({
    format: z.literal(RECIPE_PROGRESS_FORMAT),
    recipe: z
      .object({
        id: z.string().regex(RECIPE_PROGRESS_RECIPE_ID_RE),
        version: z.string().regex(RECIPE_PROGRESS_VERSION_RE),
      })
      .strict(),
    checkpoints: RecipeCheckpointMapSchema,
    table: z.string().regex(RECIPE_PROGRESS_TABLE_RE),
    discovered: z.number().int().min(0).max(PROGRESS_MAX_RECORDINGS),
    running: z.array(RecipeProgressRunningSchema).max(1),
  })
  .strict();

export type RecipeCheckpointMapItem = z.infer<typeof RecipeCheckpointMapItemSchema>;
export type RecipeProgressRunning = z.infer<typeof RecipeProgressRunningSchema>;
export type RecipeProgress = z.infer<typeof RecipeProgressSchema>;

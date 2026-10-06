/**
 * Preloaded by `bun run test:scrub` (`--preload`): a top-level `afterAll` in a preload runs once,
 * after the last test file, so whatever a file did not remove is removed when the run ends.
 */

import { afterAll } from "bun:test";
import { removeTempDirs } from "./temp-dirs";

afterAll(removeTempDirs);

/**
 * Result types for the dataset-upload pipeline steps (#907, epic #902).
 *
 * Failures are PRINTED inside the step that detects them (each step owns its
 * spinner and remediation prose); the returned status only tells the command
 * sequencer whether to continue. Step functions never call process.exit —
 * the `.action()` sequencer in commands/dataset.ts owns every exit.
 *
 * Only fallible steps return `Step`/`GatedStep`; steps that warn-and-continue
 * by construction return plain values.
 */

export type StepOk<T> = { status: "ok"; value: T };
export type StepFail = { status: "fail" };
/** Clean early finish (e.g. --dry-run): stop the pipeline, exit code 0. */
export type StepStop = { status: "stop" };

export type Step<T = void> = StepOk<T> | StepFail;
export type GatedStep<T = void> = StepOk<T> | StepFail | StepStop;

export function ok(): StepOk<void>;
export function ok<T>(value: T): StepOk<T>;
export function ok<T>(value?: T): StepOk<T> {
  return { status: "ok", value: value as T };
}

export const FAIL: StepFail = { status: "fail" };
export const STOP: StepStop = { status: "stop" };

/** Backend dataset descriptor threaded through the transfer/finalize steps. */
export interface DatasetInfo {
  dataset_id: string;
  ssh_url: string;
  s3_prefix: string;
  github_url: string;
  upload_urls: Record<string, string>;
  s3_config: {
    bucket: string;
    region: string;
    public_url: string;
  };
}

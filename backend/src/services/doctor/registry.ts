/**
 * Registry of all doctor checks.
 *
 * Adding a new check: implement it under `./checks/`, then import + push into
 * the array below. No other wiring needed.
 */

import { missingManifestCheck } from "./checks/missing-manifest";
import type { DoctorCheck } from "./types";

export const DOCTOR_CHECKS: ReadonlyArray<DoctorCheck> = [missingManifestCheck];

export function getCheck(name: string): DoctorCheck | undefined {
  return DOCTOR_CHECKS.find((c) => c.name === name);
}

export function listChecks(): Array<{ name: string; description: string }> {
  return DOCTOR_CHECKS.map((c) => ({ name: c.name, description: c.description }));
}

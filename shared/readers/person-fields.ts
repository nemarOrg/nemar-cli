/**
 * The one person-field rule of the identifier screen's readers (lead rulings on card A4): the
 * HDF5 and SNIRF readers and the text header readers (BrainVision, NIRx) all import it, so a field
 * name means the same in every format.
 */

import { canonical } from "../identifier-scan";

/**
 * Which field names are a person's: a canonical name (lowercase, no space, `_` or `-`) that
 * contains a `person` word not qualified by a `thing` word before it, and is not one of the `own`
 * names. A field called just `name` names its own object (a stimulus, an aux channel, a group), as
 * SNIRF's `stim{k}/name` and many HDF5 layouts use it, so it is not a person's. `ExperimenterName`,
 * `PatientProfile` and `SubjectTask` are a person's; `ManufacturerName`, `AppName` and `name` are
 * not.
 */
export const PERSON_FIELDS = {
  person: ["name", "subject", "patient", "operator", "experimenter", "participant"],
  thing: [
    "manufacturer",
    "app",
    "model",
    "device",
    "software",
    "file",
    "stim",
    "aux",
    "channel",
    "cap",
    "label",
    "unit",
    "institution",
    "task",
    "condition",
    "experiment",
    "study",
    "probe",
    "montage",
    "paradigm",
  ],
  own: ["name"],
} as const;

/**
 * Is this field name (any spelling) a person's? `bareName` says what a field called just `name`
 * is: its own object's name (`object`, the default: HDF5 groups, SNIRF stimuli), or the person's,
 * where the section it sits in is about a person (`person`: NIRx `[Subject Demographics]`).
 */
export function isPersonField(
  name: string,
  options: { bareName?: "object" | "person" } = {},
): boolean {
  const c = canonical(name);
  if ((PERSON_FIELDS.own as readonly string[]).includes(c)) return options.bareName === "person";
  // A thing word suppresses a person word only when it comes before it, as its qualifier:
  // `ManufacturerName` is a manufacturer's; `PatientProfile` and `SubjectTask` are a person's.
  for (const w of PERSON_FIELDS.person) {
    for (let at = c.indexOf(w); at >= 0; at = c.indexOf(w, at + 1)) {
      const before = c.slice(0, at);
      if (!PERSON_FIELDS.thing.some((t) => before.includes(t))) return true;
    }
  }
  return false;
}

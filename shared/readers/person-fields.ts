/**
 * The one person-field rule of the identifier screen's readers (lead rulings on card A4): the
 * HDF5 and SNIRF readers and the text header readers (BrainVision, NIRx) all import it, so a field
 * name means the same in every format.
 */

/**
 * Which field names are a person's, read word by word ({@link fieldTokens}): a `person` word not
 * qualified by a `thing` word before it, in a name with no `describing` word (a field that
 * describes the person, such as `Subject_Type` or `SubjectInfo`, has its own rules), that is not
 * one of the `own` names, and whose person word is not a `name` qualified by another word
 * (`LongName`). A field called just `name` names its own object (a stimulus, an aux
 * channel, a group), as SNIRF's `stim{k}/name` and many HDF5 layouts use it. `ExperimenterName`,
 * `PatientProfile` and `SubjectTask` are a person's; `ManufacturerName`, `AppName`, `SubjectInfo`
 * and `name` are not. Words match whole, never inside another word (`cap` is not in `landscape`).
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
    "stimulus",
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
  describing: [
    "age",
    "sex",
    "gender",
    "type",
    "info",
    "history",
    "group",
    "notes",
    "remarks",
    "date",
    "contact",
    "description",
  ],
  own: ["name"],
} as const;

/**
 * The words of a field name, lowercase: split at camelCase boundaries (`SubjectID` is `subject`,
 * `id`), and at anything that is not a letter (underscores, spaces, hyphens, digits).
 */
export function fieldTokens(name: string): string[] {
  return name
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}]+/u)
    .filter((t) => t !== "")
    .map((t) => t.toLowerCase());
}

/** Whether a word before `name` makes it a thing's name: neither a person nor a describing word. */
function namesAThing(before: string): boolean {
  return !(
    (PERSON_FIELDS.person as readonly string[]).includes(before) ||
    (PERSON_FIELDS.describing as readonly string[]).includes(before)
  );
}

/**
 * Is this field name (any spelling) a person's? `bareName` says what a field called just `name`
 * is: its own object's name (`object`, the default: HDF5 groups, SNIRF stimuli), or the person's,
 * where the section it sits in is about a person (`person`: NIRx `[Subject Demographics]`).
 */
export function isPersonField(
  name: string,
  options: { bareName?: "object" | "person" } = {},
): boolean {
  const tokens = fieldTokens(name);
  const has = (list: readonly string[], t: string) => list.includes(t);
  if (tokens.length === 1 && has(PERSON_FIELDS.own, tokens[0] as string)) {
    return options.bareName === "person";
  }
  if (tokens.some((t) => has(PERSON_FIELDS.describing, t))) return false;
  // A thing word suppresses a person word only when it comes before it, as its qualifier:
  // `ManufacturerName` is a manufacturer's; `PatientProfile` and `SubjectTask` are a person's.
  // `name` after any word that is neither a person word nor a describing word is that thing's
  // name (`LongName`, `DepartmentName`, `LayoutName`, `trialName`); after a person word it is
  // the person's (`ExperimenterName`, `SubjectName`, `ParticipantName`). Lead ruling, card A5.
  return tokens.some(
    (t, i) =>
      has(PERSON_FIELDS.person, t) &&
      !tokens.slice(0, i).some((before) => has(PERSON_FIELDS.thing, before)) &&
      !(t === "name" && i > 0 && namesAThing(tokens[i - 1] as string)),
  );
}

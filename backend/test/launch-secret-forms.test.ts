/**
 * The helper that lists every form of a job's token in the launch value (A1c, #2043), held to the real
 * encoder: wherever the token falls in the launch specification's text, the value holds exactly the
 * form of that alignment, and a slice of the value that holds the token is found by it.
 */

import { describe, expect, test } from "bun:test";
import { encodeLaunchSpec, encodeLaunchSpecEnv } from "../../shared/contract/compute-launch";
import { launchSecretForms } from "./helpers/launch-secret-forms";

const TOKEN = "0123456789abcdef".repeat(4);

/** A valid launch specification whose token is `TOKEN`, moved later in the text by `extraBytes` bytes. */
function textWithTokenAfter(extraBytes: number): string {
  const text = encodeLaunchSpec({
    job_id: "job_0123456789abcdef01234567",
    runtime: "python",
    command: ["run", "x".repeat(1 + extraBytes)],
    args: [],
    datasets: [],
    api_base: "https://api.example.test",
    image: {
      uri: `docker://ghcr.io/example/runtime@sha256:${"b".repeat(64)}`,
      digest: `sha256:${"b".repeat(64)}`,
      sif: `${"b".repeat(64)}.sif`,
    },
    env: {},
    resources: { gpus: 0 },
    limits: { max_files: 38000, max_total_bytes: 1073741824 },
    job_token: TOKEN,
  });
  return text;
}

describe("launchSecretForms", () => {
  test("it lists the plain token, the whole value and three more forms, none of them empty or short", () => {
    const value = encodeLaunchSpecEnv(textWithTokenAfter(0));
    const forms = launchSecretForms(TOKEN, value);
    expect(forms).toHaveLength(5);
    expect(forms[0]).toBe(TOKEN);
    expect(forms[1]).toBe(value);
    for (const form of forms) expect(form.length).toBeGreaterThanOrEqual(8);
    expect(new Set(forms).size).toBe(5);
    // The plain token is not in the value, which is why the other forms exist.
    expect(value).not.toContain(TOKEN);
  });

  test("whichever alignment the token has in the text, the value holds exactly that alignment's form", () => {
    const seen = new Set<number>();
    for (let extra = 0; extra < 9; extra++) {
      const text = textWithTokenAfter(extra);
      const value = encodeLaunchSpecEnv(text);
      const [, , ...alignments] = launchSecretForms(TOKEN, value);
      const where = alignments.map((form) => value.includes(form));
      expect(where.filter(Boolean), `extra ${extra}`).toHaveLength(1);
      // And it is the alignment the token's position says: its offset in the text, modulo 3.
      expect(where.indexOf(true), `extra ${extra}`).toBe(text.indexOf(TOKEN) % 3);
      seen.add(text.indexOf(TOKEN) % 3);
    }
    // Nine texts reached all three alignments, so each form was shown to be the one that matches.
    expect(seen).toEqual(new Set([0, 1, 2]));
  });

  test("a slice of the value that holds the token is found, though the whole value and the plain token are not in it", () => {
    for (let extra = 0; extra < 3; extra++) {
      const value = encodeLaunchSpecEnv(textWithTokenAfter(extra));
      const forms = launchSecretForms(TOKEN, value);
      // The last 100 characters of the value hold the token's encoding (the token ends the text).
      const tail = value.slice(-100);
      expect(tail).not.toContain(TOKEN);
      expect(tail.includes(value)).toBe(false);
      expect(
        forms.some((form) => tail.includes(form)),
        `extra ${extra}`,
      ).toBe(true);
    }
  });

  test("a token too short to have a form of its own is refused rather than matching everything", () => {
    expect(() => launchSecretForms("abc", "x")).toThrow("too short");
  });
});

/**
 * Every form a job's token takes in the launch value, for the tests that look for a leak (contract
 * follow-up A1c, #2043).
 *
 * The launch value is the launch specification's text in base64url, and the token is inside that
 * text, so the plain token is NOT a substring of the value. A check for the plain token and for the
 * whole value then misses a leak of PART of the value, such as a log line that carries a slice of it,
 * which holds the token only in encoded form. Base64 turns three bytes into four characters, so the
 * same token is written three different ways, depending on how many bytes come before it in the text
 * (0, 1 or 2 modulo 3, which is its alignment in a group). `launchSecretForms` returns all of them,
 * and one helper keeps every leak list in step.
 */

/**
 * The plain token, the whole value, and the token's base64url text at each of its three alignments.
 * An alignment's form is the characters whose three-byte groups lie wholly inside the token, so the
 * bytes around the token cannot change them. The independent oracle is Node's own base64url, not the
 * contract's encoder, so a bug in the encoder cannot hide a form.
 */
export function launchSecretForms(token: string, launchSpecEnv: string): string[] {
  const forms = [token, launchSpecEnv];
  for (let before = 0; before < 3; before++) {
    // `before` bytes ahead of the token, in a text whose other bytes do not matter.
    const encoded = Buffer.from("x".repeat(before) + token, "latin1").toString("base64url");
    const from = Math.ceil(before / 3) * 4;
    const to = Math.floor((before + token.length) / 3) * 4;
    const form = encoded.slice(from, to);
    // An empty or tiny form would match nearly anything, which would make a leak check meaningless.
    if (form.length < 8) throw new Error("the token is too short to have a form of its own");
    forms.push(form);
  }
  return forms;
}

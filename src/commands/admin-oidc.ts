/**
 * `nemar admin oidc`: NEMAR as an OpenID Connect provider (epic #2014 phase #2016; ADR 0119). Owner
 * role.
 *
 *   nemar admin oidc clients add            register a client; its secret is printed once
 *   nemar admin oidc clients list           every client
 *   nemar admin oidc clients show <id>      one client in full
 *   nemar admin oidc clients rotate-secret  a new secret; the old one stays valid for a grace
 *   nemar admin oidc clients disable        cut a client off
 *   nemar admin oidc keys list              the signing keys and their states
 *   nemar admin oidc keys rotate            make the first keys, or rotate them
 *
 * A secret is printed on `add` and on `rotate-secret` and nowhere else, and no command prints a
 * hash or a private key, because the Worker returns none. Every command takes `--json`: standard
 * output is then the Worker's answer and nothing else, and every sentence goes to standard error.
 * Every string that came from the network is made plain before it is printed.
 *
 * The routes exist only on a Worker whose provider is on (`OIDC_SECRET`) and only on the issuer's
 * own host, so a 404 here is said plainly (`hintsFor`), and not as "this backend does not support
 * this command yet".
 */

import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";
import type { OidcClientView, OidcKeyView } from "../../shared/contract/oidc-admin.js";
import {
  OIDC_CONSENT_MODES,
  OIDC_SECRET_GRACE_HOURS_DEFAULT,
  OIDC_SECRET_GRACE_HOURS_MAX,
  OIDC_SIGN_IN_RULES,
} from "../../shared/oidc.js";
import { failMessage, failWith, requireSignedIn, say } from "../lib/admin-command.js";
import { isRouteNotFound } from "../lib/api/errors.js";
import {
  createOidcClient,
  disableOidcClient,
  getOidcClient,
  listOidcClients,
  listOidcKeys,
  rotateOidcClientSecret,
  rotateOidcKeys,
} from "../lib/api/oidc.js";
import { confirm } from "../lib/confirm.js";
import { clip, plain } from "../lib/terminal-text.js";

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

/** What to tell the owner for a status, in place of the generic hint. */
function hintsFor(error: unknown): Record<number, string> {
  const hints: Record<number, string> = {
    403: "These commands are for the owner role only.",
  };
  if (isRouteNotFound(error)) {
    hints[404] =
      "The server does not serve this route: the OpenID Connect provider is off there (no OIDC_SECRET), or the API URL is not the issuer's own host, or the server is older than this command.";
  }
  return hints;
}

/** Sign-in check, then the call; a failure is reported once (exit 1) and the result is null. */
async function run<T>(json: boolean, what: string, call: () => Promise<T>): Promise<T | null> {
  if (!requireSignedIn(json)) return null;
  try {
    return await call();
  } catch (err) {
    failWith(err, null, `Could not ${what}.`, hintsFor(err), { json });
    return null;
  }
}

const printJson = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

/** A comma-separated list, trimmed, with empty items dropped. */
function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function wholeNumber(max: number | undefined) {
  return (value: string): number => {
    const n = Number(value);
    if (value.trim() === "" || !Number.isInteger(n) || n < 0 || (max !== undefined && n > max)) {
      throw new InvalidArgumentError(
        max === undefined
          ? "a whole number, zero or more, is required."
          : `a whole number from 0 to ${max} is required.`,
      );
    }
    return n;
  };
}

const yesNo = (b: boolean): string => (b ? "yes" : "no");
const utc = (s: string | null): string => (s ? `${plain(s)} UTC` : "never");

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function clientLines(c: OidcClientView): string[] {
  const caps =
    c.cap_open_reservations === null && c.cap_su_per_day === null
      ? "none"
      : `open reservations ${c.cap_open_reservations ?? "none"}, service units per day ${c.cap_su_per_day ?? "none"}`;
  return [
    `${chalk.bold(plain(c.client_id))}  ${plain(c.name)}`,
    `  Status:            ${plain(c.status)}${c.disabled_at ? ` (since ${utc(c.disabled_at)})` : ""}`,
    `  First-party:       ${yesNo(c.first_party)}${c.first_party ? " (skips the consent screen)" : ""}`,
    `  Sign-in rule:      ${plain(c.sign_in_rule)}`,
    `  Consent:           ${plain(c.consent_mode)}`,
    `  Audience:          ${plain(c.audience)}`,
    `  Redirect URIs:     ${c.redirect_uris.map(plain).join("\n                     ")}`,
    `  Scopes:            ${c.allowed_scopes.map(plain).join(", ")}`,
    `  Grants:            ${c.allowed_grants.map(plain).join(", ")}`,
    `  Logout URI:        ${c.backchannel_logout_uri ? plain(c.backchannel_logout_uri) : "none"}`,
    `  Introspection:     ${c.introspection_audiences.length ? c.introspection_audiences.map(plain).join(", ") : "none"}`,
    `  Caps:              ${caps}`,
    `  Previous secret:   ${c.previous_secret_expires_at ? `still valid until ${utc(c.previous_secret_expires_at)}` : "none"}`,
    `  Registered:        ${utc(c.created_at)} by user ${c.created_by}`,
  ];
}

function clientTable(clients: OidcClientView[]): string[] {
  const rows = clients.map((c) => [
    plain(c.client_id),
    clip(c.name, 32),
    plain(c.status),
    c.first_party ? "first-party" : "third-party",
    plain(c.sign_in_rule),
    String(c.allowed_scopes.length),
  ]);
  const head = ["CLIENT ID", "NAME", "STATUS", "KIND", "SIGN-IN RULE", "SCOPES"];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] as string).length)),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return [chalk.bold(fmt(head)), ...rows.map(fmt)];
}

function keyTable(keys: OidcKeyView[]): string[] {
  const rows = keys.map((k) => [
    plain(k.kid),
    plain(k.state),
    plain(k.alg),
    utc(k.created_at),
    k.promoted_at
      ? utc(k.promoted_at)
      : k.promotable_at
        ? `may be promoted ${utc(k.promotable_at)}`
        : "-",
    k.retired_at ? utc(k.retired_at) : "-",
  ]);
  const head = ["KEY ID", "STATE", "ALG", "CREATED", "PROMOTED", "RETIRED"];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] as string).length)),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return [chalk.bold(fmt(head)), ...rows.map(fmt)];
}

// ---------------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------------

const ADD_HELP = `
Registers an OpenID Connect client (owner only). The client's secret is printed once, here, and
cannot be read again: store it now. Only its hash is kept. A refusal prints the Worker's reason,
which names the field and never repeats what was typed.

  --redirect-uri     One to ten exact addresses (repeat the flag). https only; a loopback address may
                     use http outside production; no wildcard, no fragment, no user information.
  --scopes           A comma-separated list from the catalogue: openid, profile, email, orcid,
                     nemar.account, offline_access, compute.read, compute.reserve, compute.submit,
                     compute.stats (compute.stats only with the client_credentials grant).
  --grants           A comma-separated list: authorization_code, refresh_token, client_credentials.
  --sign-in-rule     active_account, or person_proven_orcid (an account of kind person whose ORCID iD
                     was proven by signing in with ORCID).
  --first-party      Skips the consent screen. Allowed only when EVERY redirect address is on a NEMAR
                     web origin; a client with a partner-host or any other redirect address is
                     third-party and always shows consent.

Examples:
  nemar admin oidc clients add --name "Compute portal" --redirect-uri https://portal.example.org/cb \\
    --scopes openid,profile,orcid --grants authorization_code --sign-in-rule person_proven_orcid \\
    --audience https://api.nemar.org

Exit codes:
  0  registered; the secret was printed.
  1  not signed in, not the owner, a missing or malformed flag, a refusal of the registry (nothing
     was registered), or a server on which the provider is off.`;

const LIST_HELP = `
Lists every registered client: its id, name, status, whether it is first-party, its sign-in rule and
how many scopes it may ask for. No secret, no hash. Use \`show\` for one client in full.

Exit codes:
  0  listed (an empty registry is not a failure).
  1  not signed in, not the owner, or a server on which the provider is off.`;

const SHOW_HELP = `
Shows one client in full: redirect addresses, scopes, grants, caps, and whether a previous secret is
still valid after a rotation. No secret, no hash.

Exit codes:
  0  shown.
  1  not signed in, not the owner, no such client, or a server on which the provider is off.`;

const ROTATE_SECRET_HELP = `
Makes a new secret for the client and prints it once; store it now. The old secret stays valid for
--grace-hours (default ${OIDC_SECRET_GRACE_HOURS_DEFAULT}, at most ${OIDC_SECRET_GRACE_HOURS_MAX}; 0 ends it at once), so a client that has
not been given the new one keeps working. A second rotation inside the grace ends the first secret.
A disabled client's secret cannot be rotated.

Exit codes:
  0  rotated; the new secret was printed.
  1  not signed in, not the owner, no such client, a disabled client, a grace out of range, or a
     server on which the provider is off.`;

const DISABLE_HELP = `
Cuts a client off: it can no longer authenticate. There is no command to enable it again, so it asks
first (--yes answers). This phase sets the status only; revoking what the client already holds is a
later phase.

Exit codes:
  0  disabled, or it already was (the answer says which).
  1  not signed in, not the owner, no such client, the question was not answered yes (nothing was
     changed), or a server on which the provider is off.`;

const KEYS_LIST_HELP = `
Lists the signing keys: current (signs), next (published, not yet signing), and retired (still
published for seven days). A next key shows when it may become current without --force. The private
half is never returned.

Exit codes:
  0  listed (no keys yet is not a failure).
  1  not signed in, not the owner, or a server on which the provider is off.`;

const KEYS_ROTATE_HELP = `
With no keys yet, makes the first current key and a next key. After that, the next key becomes
current, the current key is retired (still published for seven days, so a token signed just before
the rotation verifies), and a new next key is made. The next key becomes current only when it is
24 hours old, so a client has time to fetch it; --force skips that wait.

Set OIDC_SECRET on the Worker before the first rotation: it encrypts the private keys, and changing
it afterwards makes every stored key unreadable.

Exit codes:
  0  rotated, or the first keys were made.
  1  not signed in, not the owner, the next key is not 24 hours old yet (nothing changed; --force
     rotates now), another rotation won the race (read the keys again), or a server on which the
     provider is off.`;

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

export const oidcCommand = new Command("oidc").description(
  "Register OpenID Connect clients and manage NEMAR's signing keys (owner only; ADR 0119)",
);

const clientsCommand = new Command("clients").description(
  "Register and manage OpenID Connect clients",
);
const keysCommand = new Command("keys").description("List and rotate the signing keys");

interface AddOptions {
  name: string;
  redirectUri: string[];
  scopes: string;
  grants: string;
  signInRule: string;
  consentMode?: string;
  firstParty?: boolean;
  logoutUri?: string;
  audience: string;
  introspectionAudiences?: string;
  capOpenReservations?: number;
  capSuPerDay?: number;
  json?: boolean;
}

clientsCommand
  .command("add")
  .description("Register a client; its secret is printed once")
  .requiredOption("--name <name>", "What the consent screen and the listing call the client")
  .option("--redirect-uri <uri>", "An exact redirect address (repeat for up to ten)", collect, [])
  .requiredOption("--scopes <list>", "Comma-separated scopes the client may ask for")
  .requiredOption("--grants <list>", "Comma-separated grants the client may use")
  .addOption(
    new Option("--sign-in-rule <rule>", "Who may sign in to the client")
      .choices([...OIDC_SIGN_IN_RULES])
      .makeOptionMandatory(),
  )
  .addOption(
    new Option("--consent-mode <mode>", "Ask once per set of scopes, or every time").choices([
      ...OIDC_CONSENT_MODES,
    ]),
  )
  .option("--first-party", "Skip the consent screen (every redirect must be on a NEMAR web origin)")
  .option("--logout-uri <uri>", "The https address NEMAR tells when an account is cut off")
  .requiredOption("--audience <audience>", "The resource the client's access tokens are bound to")
  .option(
    "--introspection-audiences <list>",
    "Comma-separated audiences whose servers may introspect",
  )
  .option("--cap-open-reservations <n>", "Cap on open reservations", wholeNumber(undefined))
  .option("--cap-su-per-day <n>", "Cap on service units reserved per day", wholeNumber(undefined))
  .option("--json", "Print the answer as JSON (the secret included)")
  .addHelpText("after", ADD_HELP)
  .action(async (options: AddOptions) => {
    const json = options.json === true;
    if (options.redirectUri.length === 0) {
      failMessage("Give at least one --redirect-uri.", { json, answered: true });
      return;
    }
    const result = await run(json, "register the client", () =>
      createOidcClient({
        name: options.name,
        redirect_uris: options.redirectUri,
        allowed_scopes: list(options.scopes),
        allowed_grants: list(options.grants),
        sign_in_rule: options.signInRule,
        audience: options.audience,
        ...(options.firstParty ? { first_party: true } : {}),
        ...(options.consentMode ? { consent_mode: options.consentMode } : {}),
        ...(options.logoutUri ? { backchannel_logout_uri: options.logoutUri } : {}),
        ...(options.introspectionAudiences
          ? { introspection_audiences: list(options.introspectionAudiences) }
          : {}),
        ...(options.capOpenReservations !== undefined
          ? { cap_open_reservations: options.capOpenReservations }
          : {}),
        ...(options.capSuPerDay !== undefined ? { cap_su_per_day: options.capSuPerDay } : {}),
      }),
    );
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    const out = say(false);
    out(`Registered ${plain(result.client.client_id)} (${plain(result.client.name)}).`);
    out("");
    out(`Client secret (shown once, store it now): ${plain(result.client_secret)}`);
    out(
      chalk.dim("It cannot be read again; only its hash is kept. Rotate it with `rotate-secret`."),
    );
  });

clientsCommand
  .command("list")
  .description("List every client")
  .option("--json", "Print the list as JSON")
  .addHelpText("after", LIST_HELP)
  .action(async (options: { json?: boolean }) => {
    const json = options.json === true;
    const result = await run(json, "list the clients", listOidcClients);
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    if (result.clients.length === 0) {
      console.log("No clients are registered.");
      return;
    }
    for (const line of clientTable(result.clients)) console.log(line);
  });

clientsCommand
  .command("show <client_id>")
  .description("Show one client in full")
  .option("--json", "Print the client as JSON")
  .addHelpText("after", SHOW_HELP)
  .action(async (clientId: string, options: { json?: boolean }) => {
    const json = options.json === true;
    const result = await run(json, "show the client", () => getOidcClient(clientId));
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    for (const line of clientLines(result.client)) console.log(line);
  });

clientsCommand
  .command("rotate-secret <client_id>")
  .description("Make a new secret; the old one stays valid for a grace")
  .option(
    "--grace-hours <n>",
    `Hours the old secret stays valid (default ${OIDC_SECRET_GRACE_HOURS_DEFAULT}, 0 to 168)`,
    wholeNumber(OIDC_SECRET_GRACE_HOURS_MAX),
  )
  .option("--json", "Print the answer as JSON (the secret included)")
  .addHelpText("after", ROTATE_SECRET_HELP)
  .action(async (clientId: string, options: { graceHours?: number; json?: boolean }) => {
    const json = options.json === true;
    const result = await run(json, "rotate the secret", () =>
      rotateOidcClientSecret(clientId, options.graceHours),
    );
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    const out = say(false);
    out(`Rotated the secret of ${plain(result.client.client_id)} (${plain(result.client.name)}).`);
    out("");
    out(`New client secret (shown once, store it now): ${plain(result.client_secret)}`);
    out(
      result.grace_hours > 0
        ? `The old secret stays valid for ${result.grace_hours} ${result.grace_hours === 1 ? "hour" : "hours"}${result.client.previous_secret_expires_at ? `, until ${utc(result.client.previous_secret_expires_at)}` : ""}.`
        : "The old secret is no longer valid.",
    );
  });

clientsCommand
  .command("disable <client_id>")
  .description("Cut a client off (it cannot be enabled again from the CLI)")
  .option("-y, --yes", "Do not ask first")
  .option("--json", "Print the answer as JSON")
  .addHelpText("after", DISABLE_HELP)
  .action(async (clientId: string, options: { yes?: boolean; json?: boolean }) => {
    const json = options.json === true;
    if (!requireSignedIn(json)) return;
    const answer = await confirm(
      `Disable ${clientId}? It can no longer authenticate, and the CLI cannot enable it again.`,
      { yes: options.yes },
    );
    if (answer !== "confirmed") {
      failMessage("Not disabled: the question was not answered yes (use --yes).", {
        json,
        answered: true,
      });
      return;
    }
    const result = await run(json, "disable the client", () => disableOidcClient(clientId));
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    say(false)(
      result.changed
        ? `Disabled ${plain(result.client.client_id)} (${plain(result.client.name)}).`
        : `${plain(result.client.client_id)} was already disabled; nothing changed.`,
    );
  });

keysCommand
  .command("list")
  .description("List the signing keys")
  .option("--json", "Print the keys as JSON")
  .addHelpText("after", KEYS_LIST_HELP)
  .action(async (options: { json?: boolean }) => {
    const json = options.json === true;
    const result = await run(json, "list the signing keys", listOidcKeys);
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    if (result.keys.length === 0) {
      console.log(
        "There are no signing keys yet. Run `nemar admin oidc keys rotate` to make them.",
      );
      return;
    }
    for (const line of keyTable(result.keys)) console.log(line);
  });

keysCommand
  .command("rotate")
  .description("Make the first signing keys, or rotate them")
  .option("--force", "Rotate now even when the next key is under 24 hours old")
  .option("--json", "Print the answer as JSON")
  .addHelpText("after", KEYS_ROTATE_HELP)
  .action(async (options: { force?: boolean; json?: boolean }) => {
    const json = options.json === true;
    const result = await run(json, "rotate the signing keys", () => rotateOidcKeys(options.force));
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    const out = say(false);
    const words: Record<string, string> = {
      bootstrapped: "Made the first signing keys: a current key and a next key.",
      rotated:
        "Rotated: the next key is now current, the old current key is retired (still published for seven days), and a new next key was made.",
      next_created: "Made a new next key; the current key is unchanged.",
    };
    out(plain(words[result.action] ?? `Done (${result.action}).`));
    for (const line of keyTable(result.keys)) console.log(line);
  });

oidcCommand.addCommand(clientsCommand);
oidcCommand.addCommand(keysCommand);

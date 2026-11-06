/**
 * The OpenID Foundation conformance suite's plan configurations for the NEMAR provider (epic #2014
 * phase #2020), as pure functions of the rig's addresses and the throwaway client credentials the rig
 * has just registered.
 *
 * Two plans run: the configuration plan (`oidcc-config-certification-test-plan`, no browser), and the
 * Basic plan (`oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=
 * static_client]`), whose scripted browser (HtmlUnit) signs in and consents through the rig's pages.
 *
 * The browser vocabulary is the suite's: `click`, `text`, `wait`; elements by `id`, `name`, `xpath`,
 * `css`; a task runs for a page whose address matches its pattern, and an `optional` task is skipped
 * when no such page appears. A command that ends in `update-image-placeholder` stands in for the
 * screenshot a human certifier would upload.
 *
 * A configuration holds client secrets, so the rig writes it to a directory that is never uploaded.
 */

/** The text each stand-in page shows, which the suite's `wait` commands look for. */
export const RIG_TEXT = {
  signIn: "Sign in to NEMAR",
  redirectNotRegistered: "has not registered",
} as const;

/** The test e-mail account the rig seeds; the `.test` domain makes the sign-in code echo outside production. */
export const RIG_ACCOUNT_EMAIL = "conformance@nemar.test";

export interface PlanAddresses {
  /** The provider's issuer and the rig's own origin: `https://rig.example.org:9443`. */
  readonly issuer: string;
  /** The suite's alias, which fixes its callback address: `<suite>/test/a/<alias>/callback`. */
  readonly alias: string;
}

export interface ClientCredentials {
  readonly client_id: string;
  readonly client_secret: string;
}

type Command = Array<string | number>;
interface Task {
  task: string;
  optional?: boolean;
  match?: string;
  commands?: Command[];
}
interface BrowserBlock {
  comment?: string;
  match: string;
  tasks: Task[];
}

/** The redirect address a suite with this alias sends the browser back to. */
export function callbackAddress(suiteOrigin: string, alias: string): string {
  return `${suiteOrigin.replace(/\/+$/, "")}/test/a/${alias}/callback`;
}

function loginTask(issuer: string, withPlaceholder: boolean): Task {
  const commands: Command[] = [];
  if (withPlaceholder) {
    commands.push([
      "wait",
      "xpath",
      "//*",
      10,
      RIG_TEXT.signIn,
      "update-image-placeholder-optional",
    ]);
  }
  commands.push(
    ["text", "name", "email", RIG_ACCOUNT_EMAIL, "optional"],
    ["click", "id", "signin"],
  );
  return { task: "Login", optional: true, match: `${issuer}/login*`, commands };
}

function consentTask(issuer: string): Task {
  // The Deny button comes first on the page, so the Allow button is chosen by its value.
  return {
    task: "Consent",
    optional: true,
    match: `${issuer}/oauth/authorize*`,
    commands: [["click", "xpath", "//button[@value='allow']"]],
  };
}

const verifyComplete: Task = {
  task: "Verify Complete",
  match: "*/test/*/callback*",
  commands: [["wait", "id", "submission_complete", 10]],
};

function standardBrowser(issuer: string, withPlaceholder = false): BrowserBlock[] {
  return [
    {
      match: `${issuer}/oauth/authorize*`,
      tasks: [loginTask(issuer, withPlaceholder), consentTask(issuer), verifyComplete],
    },
  ];
}

/** The configuration plan reads the discovery document and nothing else: no client, no browser. */
export function buildConfigPlanConfig(addr: PlanAddresses): Record<string, unknown> {
  return {
    alias: `${addr.alias}-config`,
    description: "NEMAR OpenID Connect provider: configuration",
    server: { discoveryUrl: `${addr.issuer}/.well-known/openid-configuration` },
  };
}

/** The Basic plan: two static clients, the scripted sign-in and consent, and the four overrides. */
export function buildBasicPlanConfig(
  addr: PlanAddresses,
  clients: { client: ClientCredentials; client2: ClientCredentials },
): Record<string, unknown> {
  const { issuer } = addr;
  return {
    alias: addr.alias,
    description: "NEMAR OpenID Connect provider: Basic profile",
    server: { discoveryUrl: `${issuer}/.well-known/openid-configuration` },
    client: { ...clients.client },
    client2: { ...clients.client2 },
    browser: standardBrowser(issuer),
    override: {
      // Both sign in a second time; the sign-in page is what a certifier would screenshot.
      "oidcc-prompt-login": { browser: standardBrowser(issuer, true) },
      "oidcc-max-age-1": { browser: standardBrowser(issuer, true) },
      // An unregistered redirect address is an error page, never a redirect.
      "oidcc-ensure-registered-redirect-uri": {
        browser: [
          {
            comment: "expect an immediate error page",
            match: `${issuer}/oauth/authorize*`,
            tasks: [
              {
                task: "Expect redirect uri mismatch error page",
                match: `${issuer}/oauth/authorize*`,
                commands: [
                  [
                    "wait",
                    "xpath",
                    "//*",
                    10,
                    RIG_TEXT.redirectNotRegistered,
                    "update-image-placeholder",
                  ],
                ],
              },
            ],
          },
        ],
      },
    },
  };
}

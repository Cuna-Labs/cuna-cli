import { brandedEnvironmentNames } from "./namespace.js";

/**
 * The product's public web destinations, and the sentences that point at them.
 *
 * WHY THIS FILE EXISTS. Measured on the installed build: `cuna --help` contained
 * ZERO matches for `https?://`, and the credential hint said "Set CUNA_API_KEY to
 * a Cuna automation credential" without saying where a credential comes from.
 * Both exits from the first-run wall were closed — `login` and `signup` fail on
 * this platform, and the automation path named no source. A user who has never
 * seen the console had nowhere to go.
 *
 * WHY IT IS ONE AUTHORITY AND NOT A STRING PER SITE. Four independent places
 * already told the user about the automation credential:
 *
 *   - `api/http.ts`            "Replace CUNA_API_KEY with a valid automation credential."
 *   - `auth/human-session.ts`  the `AUTOMATION_CREDENTIAL_HINT` constant
 *   - `commands/commands.ts`   "Run `cuna login` … or set CUNA_API_KEY …"
 *   - `cli/help.ts`            the Authentication block
 *
 * Four spellings of one fact, compared by nobody. That is the exact recurring
 * defect this repository has closed four times in other namespaces: a value is
 * minted in one place and repeated in another, one side is edited, and the two
 * drift. Adding the URL to one of the four would have created a fifth variant
 * rather than closing the hole, so the sentence itself moved here.
 *
 * WHAT IS DELIBERATELY NOT HERE. No marketing apex, no docs URL, no social
 * link. A CLI that prints product URLs everywhere is its own defect; each
 * destination below exists because a specific, measured message dead-ends
 * without it, and for no other reason.
 */

/** The console origin. Verified 2026-08-10: 200 after its sign-in redirect. */
export const CONSOLE_ORIGIN = "https://app.getcuna.com" as const;

/**
 * Where an automation credential is created.
 *
 * Verified 2026-08-10 from this machine: `GET https://app.getcuna.com/api-keys`
 * answers `307` to `https://getcuna.com/login?next=…%2Fapi-keys` when
 * unauthenticated, and `200 text/html` after following it. That is a real page
 * behind sign-in, not a 404 — which is the only property a hint may promise.
 */
export const API_KEYS_URL = `${CONSOLE_ORIGIN}/api-keys` as const;

/**
 * Where "contact Cuna support" actually goes.
 *
 * Two shipped hints told the user to contact support and named no destination.
 * This is the CLI's published `bugs.url`; `test/product-web.test.mjs` asserts it
 * is byte-identical to `package.json`, so the two cannot drift.
 */
export const SUPPORT_URL = "https://github.com/Cuna-Labs/cuna-cli/issues" as const;

/**
 * The one sentence that tells a user how to authenticate without a browser.
 *
 * The variable name is read from `brandedEnvironmentNames`, the same authority
 * the resolver reads, so a change to the accepted set cannot leave this
 * sentence naming a variable nothing reads. The URL is a literal because it is
 * not derived from anything in this tree — it is a fact about a deployed site,
 * and `test/product-web.test.mjs` pins it with a literal oracle.
 */
export function automationCredentialHint(): string {
  const primary = brandedEnvironmentNames("API_KEY")[0];
  return `Create an automation credential at ${API_KEYS_URL}, then set ${primary} to it.`;
}

/**
 * The one sentence for "the server answered, but not within its own contract".
 *
 * Deliberately not "retry". Nothing the caller can do locally changes the
 * outcome — the deployed API is behind its published contract and the CLI is
 * correct to refuse the body — so the honest remedy is to say that plainly and
 * name a destination. Four mint sites emit this class
 * (`api/client.ts`, `api/http.ts`, `auth/human-contracts.ts`,
 * `commands/commands.ts`); they share this constant so they cannot drift into
 * four different degrees of helpfulness, which is exactly what had happened to
 * `details` before this change.
 */
export const OFF_CONTRACT_RESPONSE_HINT =
  "The deployed Cuna API is behind its published contract, so this cannot be fixed from the CLI. " +
  `Run \`cuna version --json\` and report it with the details above at ${SUPPORT_URL}.`;

/**
 * The one sentence for a guard that can only fire on a CLI bug.
 *
 * Four `cuna.internal.*` guards and the four request-encoding guards are
 * unreachable from any invocation: they assert the CLI's own construction of a
 * request. Shipping them with no hint told the user their command was at fault.
 * Naming the CLI as the defective party is the actionable content.
 */
export const INTERNAL_DEFECT_HINT =
  "This is a defect in the Cuna CLI, not in your invocation. " +
  `Run \`cuna version --json\` and report it with that record at ${SUPPORT_URL}.`;

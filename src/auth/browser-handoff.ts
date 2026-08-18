import type { BrowserOpener } from "./browser.js";

/**
 * How the continuation URL reached the user.
 *
 * `printed_only` is a success, not a degradation to report as a failure: the
 * printed URL is a complete affordance on its own. Spawning a browser is the
 * convenience, not the mechanism.
 */
export type BrowserHandoffOutcome = "opened" | "printed_only";

/**
 * The terminal side of the browser handoff.
 *
 * Declared here, in the auth layer, and implemented in the CLI layer: this
 * module owns *when* the user is told, and the caller owns *how* it is
 * rendered. Splitting it the other way is how the URL came to be produced and
 * never delivered.
 */
export interface BrowserHandoffReporter {
  /**
   * Deliver the continuation URL to the user.
   *
   * Called exactly once, before any open attempt, on every path. This is the
   * only delivery of the URL there is: the console's `/cli/continue` page reads
   * its continuation proof from the URL fragment and refuses to fall back to an
   * older one, and the CLI is the only holder of that fragment. If this is not
   * called, the sign-in cannot be completed by any means.
   */
  continuationUrl(url: string): void;
  /** The open attempt succeeded. Must not restate the URL. */
  browserOpened(): void;
  /** The open attempt failed. Must not restate the URL. */
  browserOpenFailed(): void;
}

/**
 * Deliver the browser continuation to the user, then try to open it.
 *
 * The order is the invariant, and it is the reason this is one function rather
 * than two call sites: printing and opening are one obligation with one
 * failure mode. `open` spawns a detached child process, so it can fail on a
 * headless host, over SSH, inside WSL, with no registered default browser, or
 * under a hardened desktop policy. Announcing first makes every one of those a
 * cosmetic loss instead of a dead end.
 *
 * An open failure is therefore contained rather than propagated. The URL has
 * already reached the user by the time it can happen, so failing the sign-in
 * here would discard a working flow because a convenience did not work.
 *
 * `url` is the server-minted `browser_url`, already validated by
 * `decodeCliContinuationIssued` against the bootstrap-advertised origin, the
 * `/cli/continue` path and the exact fragment binding. This function never
 * constructs or edits a URL: the CLI accepts the one authority the service
 * minted and forwards it unchanged.
 */
export async function handOffContinuationToBrowser(input: {
  readonly url: string;
  readonly opener: BrowserOpener;
  readonly reporter: BrowserHandoffReporter;
}): Promise<BrowserHandoffOutcome> {
  input.reporter.continuationUrl(input.url);
  try {
    await input.opener.open(input.url);
  } catch {
    input.reporter.browserOpenFailed();
    return "printed_only";
  }
  input.reporter.browserOpened();
  return "opened";
}

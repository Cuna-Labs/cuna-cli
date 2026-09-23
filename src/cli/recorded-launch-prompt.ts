/**
 * THE ONE QUESTION THE CLI ASKS MID-JOURNEY, AND WHAT THE SCREEN OWES THE
 * PERSON THE MOMENT THEY ANSWER IT.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN `run.ts`. Measured 2026-09-22
 * (`prds/cuna-cli-latency-before-20260922.md` § 3, finding 1): after this
 * answer was accepted, the terminal went BYTE-silent — no output at all, not a
 * repeating spinner — for 2 317 ms, 3 864 ms and 18 314 ms in three of five
 * runs. The screen froze on the person's own keystroke, which is the worst
 * shape a stall can take, because the last thing they did is the thing that
 * appears to have broken it.
 *
 * The cause was structural: the question gave the progress row up in order to
 * be readable, and nothing took the row back until the next remote step
 * happened to report. Whatever that step cost was silence. So the repair is not
 * "make the next step faster" — it is that the answer itself is an event worth
 * rendering, and it is rendered from the branch that was actually taken rather
 * than from the question that was asked.
 *
 * Keeping it here rather than inline is what makes that assertable: `run.ts`
 * reaches this code only through a real TTY, a real `process.stdin` and a
 * 90 ms paint timer, none of which can express the defect, which was entirely
 * about WHEN a line appears relative to an answer.
 */

/**
 * Asked verbatim, and quoted verbatim in the measurement, so the two can be
 * compared without guessing which build produced a transcript.
 */
export const RECORDED_LAUNCH_QUESTION =
  "A previous launch is recorded. Create another session? [y/N; No resumes the recorded launch] ";

/**
 * Asked instead when the recorded launch's session is known to have ended:
 * there is nothing to resume, so No may not promise one (qa6 re-witness
 * 2026-09-23, run j6: "No resumes" led to a dead session called "reused").
 */
export const RECORDED_LAUNCH_ENDED_QUESTION =
  "The last session for this folder has ended. Start a new session? [y/N; No starts nothing] ";

/**
 * How long the screen may stay unchanged after the answer is accepted.
 *
 * DERIVATION. Not a tuning knob: it is the bound this module exists to hold,
 * and it is deliberately far below the 2 000 ms threshold the measurement used
 * to call a stall a stall, because a stall that begins on the person's own
 * keypress reads as a crash rather than as waiting. The measured worst case was
 * 18 314 ms, which is 36 times this.
 */
export const RECORDED_LAUNCH_ACKNOWLEDGEMENT_BUDGET_MS = 500;

/**
 * What answers the recorded-launch question for a folder journey.
 * `--new-session` is that answer already given on the command line, so it is
 * not asked again: asking let a No, or a slow answer, override the flag (qa6
 * witness 2026-09-22). Without the flag the person is asked.
 */
export function recordedLaunchConfirmation<A extends unknown[]>(
  newSessionFlag: boolean,
  ask: (...args: A) => Promise<boolean>,
): (...args: A) => Promise<boolean> {
  return newSessionFlag ? async () => true : ask;
}

/** Only an explicit yes creates; anything else, including empty, resumes. */
export function recordedLaunchWantsNewSession(answer: string): boolean {
  return /^y(?:es)?$/iu.test(answer.trim());
}

/**
 * What the screen says next, named for the branch that was taken rather than
 * for the question that was asked.
 *
 * `No` resumes a launch that already exists, and calling that "Creating" would
 * be the CLI announcing work it is not about to do — which is the same defect
 * as the silence, one layer up: a screen that does not describe what is
 * happening.
 */
export function recordedLaunchAcknowledgement(wantsNewSession: boolean, createLabel: string, ended = false): string {
  if (wantsNewSession) return createLabel;
  return ended ? "Not starting a new session" : "Resuming the recorded launch";
}

export interface RecordedLaunchPromptInput {
  /**
   * Asks the question and resolves with the raw answer. It MUST complete its
   * own teardown before resolving: the acknowledgement writes to the same
   * stream, and a line painted underneath a live readline fights it for the
   * cursor.
   */
  readonly ask: (question: string) => Promise<string>;
  /** Puts the acknowledgement on screen. Called before this function resolves. */
  readonly acknowledge: (line: string) => void;
  /** What the create branch is called, e.g. `Creating Claude Code session`. */
  readonly createLabel: string;
  /** The recorded launch's session has ended: ask the question that does not promise a resume. */
  readonly ended?: boolean;
}

/**
 * Ask the recorded-launch question and answer the screen at once.
 *
 * THE BOUND THIS GIVES, STATED EXACTLY. `acknowledge` is called synchronously
 * between the answer arriving and this function resolving, so no remote work
 * can be dispatched in between — not because a timer says so, but because
 * there is nowhere for it to go. The caller therefore cannot reintroduce the
 * measured silence by being slow; it can only reintroduce it by writing
 * nothing, which is what `acknowledge` exists to prevent.
 */
export async function askRecordedLaunch(input: RecordedLaunchPromptInput): Promise<boolean> {
  const ended = input.ended === true;
  const wantsNewSession = recordedLaunchWantsNewSession(await input.ask(ended ? RECORDED_LAUNCH_ENDED_QUESTION : RECORDED_LAUNCH_QUESTION));
  input.acknowledge(recordedLaunchAcknowledgement(wantsNewSession, input.createLabel, ended));
  return wantsNewSession;
}

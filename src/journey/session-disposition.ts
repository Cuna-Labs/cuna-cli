/**
 * WHETHER THE ROW THIS JOURNEY LANDED ON IS NEW, AS ONE RULE.
 *
 * WHY THIS FILE EXISTS. The journey's plan and the person's answer disagree on
 * one branch, and only one of them is right.
 *
 * `orchestrator.ts` derives its disposition from the selection plan: a plan of
 * `create-required` is announced as `created`. That is true of every branch but
 * one. When a recorded launch exists, `withProviderLaunchIntent`
 * (`provider-launch-intent.ts`) asks "A previous launch is recorded. Create
 * another session?" and, on No, dispatches the create carrying the RECORDED
 * operation id rather than a fresh one — which returns the session that launch
 * already produced. The plan still reads `create-required`, so the screen would
 * say `Resuming the recorded launch` and then, two lines later, `AgentSession
 * 00b6d65a · created`. One of those sentences is false, and it is the one that
 * names the row.
 *
 * THE DISCRIMINATOR IS THE ANSWER, and nothing else on the path has it: the
 * remote returns the same shape either way, and the local journal does not
 * record which id a previous launch produced. So the rule is stated here once
 * and both launch paths read it — `journey/remote-workspace.ts` for the
 * remote-only menu launch, `cli/run.ts` for the local-path journey, which owns
 * the prompt and is therefore the only caller that knows the answer.
 *
 * WHAT `reused` CLAIMS, EXACTLY. That this journey did not mint a new launch
 * identity: it either selected a row that was already there, or re-dispatched
 * the identity of a launch that had already been applied. It does NOT claim the
 * remote performed no work. That is the distinction a person needs — am I being
 * returned to something, or is something new starting — and it is the one the
 * CLI can actually establish.
 */
export type AgentSessionDisposition = "created" | "reused";

/** Which AgentSession a launch settled on, and whether it is new. */
export interface SettledAgentSession {
  readonly agentSessionId: string;
  readonly machineId: string;
  readonly disposition: AgentSessionDisposition;
}

export function settledAgentSessionDisposition(input: {
  /** What the selection plan decided before the question was asked. */
  readonly planned: AgentSessionDisposition;
  /** True once the recorded-launch question has been answered No. */
  readonly resumedRecordedLaunch: boolean;
}): AgentSessionDisposition {
  // One-directional on purpose. A recorded launch can turn a planned create
  // into a reuse; nothing can turn a plan that selected an existing row into a
  // create, so `reused` is never overwritten.
  return input.planned === "created" && input.resumedRecordedLaunch ? "reused" : input.planned;
}

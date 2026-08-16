export type IdentityState = "unknown" | "signup_required" | "verification_required" | "active" | "disabled";
export type AdmissionState = "not_requested" | "waitlisted" | "invited" | "admitted" | "denied" | "suspended";
export type WorkspaceState = "required" | "selectable" | "assigned" | "unavailable";
export type CliAuthState = "signed_out" | "authorizing" | "signed_in" | "reauthentication_required";

export interface AuthorityObservation<T extends string> {
  readonly value: T;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface OnboardingEvidence {
  readonly identity: AuthorityObservation<IdentityState>;
  readonly admission: AuthorityObservation<AdmissionState>;
  readonly workspace: AuthorityObservation<WorkspaceState> & { readonly workspaceId?: string };
  readonly cliAuth: AuthorityObservation<CliAuthState>;
}

export type OnboardingNextAction =
  | "start_signup"
  | "verify_identity"
  | "join_waitlist"
  | "wait_for_admission"
  | "select_workspace"
  | "start_login"
  | "reauthenticate"
  | "resume_intent"
  | "contact_support"
  | "retry_status";

export interface OnboardingDecision {
  readonly status: "ready" | "unfinished" | "blocked" | "unknown";
  readonly nextAction: OnboardingNextAction;
  readonly mayResumeIntent: boolean;
  readonly mayCreateMachineWithoutConfirmation: false;
  readonly reason: string;
}

function isFresh(observation: AuthorityObservation<string>, now: number): boolean {
  const observedAt = Date.parse(observation.observedAt);
  const expiresAt = Date.parse(observation.expiresAt);
  return Number.isFinite(observedAt) && Number.isFinite(expiresAt) && observedAt <= now && now < expiresAt;
}

function decision(
  status: OnboardingDecision["status"],
  nextAction: OnboardingNextAction,
  reason: string,
): OnboardingDecision {
  return Object.freeze({
    status,
    nextAction,
    mayResumeIntent: status === "ready",
    mayCreateMachineWithoutConfirmation: false,
    reason,
  });
}

/**
 * Derives one safe next action from four separate authorities. No browser text,
 * cached profile, or partial onboarding dimension can collapse into readiness.
 */
export function deriveOnboardingDecision(evidence: OnboardingEvidence, now = Date.now()): OnboardingDecision {
  if (![evidence.identity, evidence.admission, evidence.workspace, evidence.cliAuth].every((item) => isFresh(item, now))) {
    return decision("unknown", "retry_status", "authority_evidence_stale_or_invalid");
  }
  if (evidence.identity.value === "unknown" || evidence.workspace.value === "unavailable") {
    return decision("unknown", "retry_status", "authority_state_unknown");
  }
  if (evidence.identity.value === "disabled" || ["denied", "suspended"].includes(evidence.admission.value)) {
    return decision("blocked", "contact_support", "account_or_admission_blocked");
  }
  if (evidence.identity.value === "signup_required") {
    return decision("unfinished", "start_signup", "identity_signup_required");
  }
  if (evidence.identity.value === "verification_required") {
    return decision("unfinished", "verify_identity", "identity_verification_required");
  }
  if (evidence.admission.value === "not_requested") {
    return decision("unfinished", "join_waitlist", "admission_not_requested");
  }
  if (evidence.admission.value === "waitlisted" || evidence.admission.value === "invited") {
    return decision("unfinished", "wait_for_admission", `admission_${evidence.admission.value}`);
  }
  if (evidence.workspace.value !== "assigned" || evidence.workspace.workspaceId === undefined) {
    return decision("unfinished", "select_workspace", "workspace_assignment_required");
  }
  if (evidence.cliAuth.value === "reauthentication_required") {
    return decision("unfinished", "reauthenticate", "cuna_reauthentication_required");
  }
  if (evidence.cliAuth.value !== "signed_in") {
    return decision("unfinished", "start_login", "cuna_login_required");
  }
  return decision("ready", "resume_intent", "all_authorities_fresh_and_satisfied");
}


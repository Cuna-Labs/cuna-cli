import type {
  LocalActionKind,
  LocalActionProvider,
  LocalActionRequest,
  PolicyDecision,
} from "./contracts.js";

export interface LocalActionPolicyRule {
  readonly kind: LocalActionKind;
  readonly providers?: readonly LocalActionProvider[];
  readonly scopes?: readonly string[];
  readonly decision: "deny" | "ask" | "allow_once" | "allow_scoped";
  /** Required for a persisted allow_scoped rule; records an earlier interactive decision. */
  readonly userApproved?: boolean;
}

export interface LocalActionPolicyInput {
  /** Workspace-controlled declarations are a ceiling and can never grant. */
  readonly projectRequestCeiling?: readonly LocalActionPolicyRule[];
  /** User-owned device rules may allow only requests admitted by the ceiling. */
  readonly localDevicePolicy?: readonly LocalActionPolicyRule[];
}

export class LocalActionPolicyEvaluator {
  readonly #project: readonly LocalActionPolicyRule[];
  readonly #device: readonly LocalActionPolicyRule[];

  constructor(input: LocalActionPolicyInput = {}) {
    this.#project = freezeRules(input.projectRequestCeiling ?? []);
    this.#device = freezeRules(input.localDevicePolicy ?? []);
  }

  evaluate(request: LocalActionRequest, now = Date.now()): PolicyDecision {
    const project = strongestMatchingRule(this.#project, request);
    if (project?.decision === "deny") return decision(request.id, "deny", null, "project_request_ceiling", now);
    const device = strongestMatchingRule(this.#device, request);
    if (device?.decision === "deny") return decision(request.id, "deny", null, "local_device_policy", now);
    // Device policy is a ceiling/preferences file, never a live grant. Every
    // effect still needs a request-bound interactive decision for this exact
    // identity and deadline.
    return decision(request.id, "ask", null, "interactive_user", now);
  }
}

function freezeRules(rules: readonly LocalActionPolicyRule[]): readonly LocalActionPolicyRule[] {
  return Object.freeze(rules.map((rule) => Object.freeze({
    ...rule,
    ...(rule.providers === undefined ? {} : { providers: Object.freeze([...rule.providers]) }),
    ...(rule.scopes === undefined ? {} : { scopes: Object.freeze([...rule.scopes]) }),
  })));
}

function strongestMatchingRule(
  rules: readonly LocalActionPolicyRule[],
  request: LocalActionRequest,
): LocalActionPolicyRule | undefined {
  const matches = rules.filter((rule) => rule.kind === request.kind &&
    (rule.providers === undefined || rule.providers.includes(request.provider)) &&
    (rule.scopes === undefined || rule.scopes.includes(request.requestedScope)));
  const priority: Readonly<Record<LocalActionPolicyRule["decision"], number>> = {
    deny: 0,
    ask: 1,
    allow_once: 2,
    allow_scoped: 3,
  };
  return matches.sort((left, right) => priority[left.decision] - priority[right.decision])[0];
}

function decision(
  requestId: string,
  value: PolicyDecision["decision"],
  grantedScope: string | null,
  source: PolicyDecision["policySource"],
  decidedAt: number,
): PolicyDecision {
  return Object.freeze({ requestId, decision: value, grantedScope, policySource: source, decidedAt });
}

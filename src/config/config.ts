import { posix, win32 } from "node:path";

import { EXIT_CODES, CunaError } from "../core/errors.js";
import { isSecretApiKey, readBrandedEnvironment } from "../core/namespace.js";
import { isObject } from "../core/validation.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import { resolveOpenCodeFeatureGate, type OpenCodeFeatureGate } from "./opencode-feature-gate.js";

export const DEFAULT_BASE_URL = "https://api.getcuna.com" as const;
const MAX_CONFIG_BYTES = 65_536;

export type ConfigSource = "flag" | "environment" | "profile" | "default";

export interface ConfigOverrides {
  readonly profile?: string;
  readonly baseUrl?: string;
  readonly configFile?: string;
}

export interface EffectiveConfig {
  readonly platformKind: PlatformAdapter["kind"];
  readonly profile: string;
  readonly profileSource: ConfigSource;
  readonly baseUrl: string;
  readonly baseUrlSource: ConfigSource;
  readonly configFile: string;
  readonly developmentProfile: boolean;
  readonly apiKey: string | undefined;
  readonly apiKeySource: "environment" | "absent";
  /**
   * The environment-variable name that supplied the automation credential, in
   * whichever accepted spelling the caller used, or `undefined` when none is
   * set. Every message about that credential names this instead of guessing.
   */
  readonly apiKeyVariable: string | undefined;
  /**
   * Set when an automation credential is present in the environment but is not
   * a credential this product mints. It is recorded rather than thrown so that
   * the commands which read no credential still run; `assertApiKeyUsable`
   * raises it at the moment a credential authority is about to be selected.
   * `apiKey` is `undefined` whenever this is set — an unusable value is never
   * handed to the transport, and never falls back to interactive sign-in.
   */
  readonly apiKeyProblem: CunaError | undefined;
  /**
   * Local consumer admission only. It neither activates the producer nor
   * carries a credential into OpenCode or any child process.
   */
  readonly opencodeFeatureGate: OpenCodeFeatureGate;
}

/** How `config get` and `doctor` report the environment credential. */
export type EnvironmentCredentialState = "absent" | "configured_not_validated" | "invalid";

/**
 * One derivation of the credential's reportable state, shared by `config get`
 * and `doctor`. Both are diagnostics for the same fact; two spellings of it
 * would eventually disagree.
 */
export function environmentCredentialState(config: EffectiveConfig): EnvironmentCredentialState {
  if (config.apiKeyProblem !== undefined) return "invalid";
  return config.apiKey === undefined ? "absent" : "configured_not_validated";
}

/**
 * Fail closed on an environment credential that is set but unusable.
 *
 * Empty or malformed never means absent: treating it as absent would silently
 * switch the process from automation to interactive sign-in, which is a change
 * of authority the caller did not ask for. What changed is only WHERE the
 * refusal happens. It used to happen inside `resolveConfig`, which every
 * invocation runs before dispatch, so `export CUNA_API_KEY=$(fetch-secret)`
 * with a failing fetch also disabled `doctor` and `self-test --offline` — the
 * two commands whose entire purpose is diagnosing a broken environment. The
 * refusal now happens at the credential-selecting commands, and the
 * diagnostics report the same fact instead of dying on it.
 */
export function assertApiKeyUsable(config: EffectiveConfig): void {
  if (config.apiKeyProblem !== undefined) throw config.apiKeyProblem;
}

interface ProfileRecord {
  readonly development: boolean;
  readonly baseUrl?: string;
}

interface UserConfig {
  readonly selectedProfile?: string;
  readonly profiles: Readonly<Record<string, ProfileRecord>>;
}

/**
 * `variable` is the environment-variable name at fault, when the fault came
 * from the environment. Without it the hint said "correct the selected user
 * profile" while the same payload's `details.source` said `environment`: the
 * two halves of one error named different things, and the half a human reads
 * pointed at the one authority that was not involved.
 */
function configError(reason: string, source?: ConfigSource, variable?: string): CunaError {
  const hint = source === "environment"
    ? `Correct or unset ${variable ?? "the Cuna environment variable"}, then run \`cuna config get --json\`.`
    : source === "flag"
      ? "Correct the command-line option, then run `cuna config get --json`."
      : "Run `cuna config get --json` after correcting the selected user profile.";
  return new CunaError({
    code: "cuna.config.invalid",
    message: "Cuna configuration is invalid.",
    exitCode: EXIT_CODES.usage,
    hint,
    details: {
      reason,
      ...(source === undefined ? {} : { source }),
      ...(variable === undefined ? {} : { variable }),
    },
  });
}

function parseProfileName(value: string, source: ConfigSource, variable?: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw configError("invalid_profile_name", source, variable);
  }
  return value;
}

function parseUserConfig(text: string): UserConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw configError("malformed_json");
  }
  if (!isObject(parsed)) throw configError("invalid_root");
  const keys = Object.keys(parsed);
  if (keys.some((key) => !["schema_version", "selected_profile", "profiles"].includes(key))) {
    throw configError("unknown_field");
  }
  if (parsed.schema_version !== undefined && parsed.schema_version !== 1) {
    throw configError("unsupported_schema");
  }
  if (parsed.selected_profile !== undefined && typeof parsed.selected_profile !== "string") {
    throw configError("invalid_selected_profile");
  }
  if (parsed.profiles !== undefined && !isObject(parsed.profiles)) {
    throw configError("invalid_profiles");
  }
  const profiles: Record<string, ProfileRecord> = {};
  for (const [name, unsafe] of Object.entries(parsed.profiles ?? {})) {
    parseProfileName(name, "profile");
    if (!isObject(unsafe)) throw configError("invalid_profile");
    if (Object.keys(unsafe).some((key) => !["development", "base_url"].includes(key))) {
      throw configError("unsafe_profile_field");
    }
    if (unsafe.development !== undefined && typeof unsafe.development !== "boolean") {
      throw configError("invalid_development_flag");
    }
    if (unsafe.base_url !== undefined && typeof unsafe.base_url !== "string") {
      throw configError("invalid_base_url", "profile");
    }
    profiles[name] = Object.freeze({
      development: unsafe.development === true,
      ...(typeof unsafe.base_url === "string" ? { baseUrl: unsafe.base_url } : {}),
    });
  }
  return Object.freeze({
    ...(typeof parsed.selected_profile === "string"
      ? { selectedProfile: parseProfileName(parsed.selected_profile, "profile") }
      : {}),
    profiles: Object.freeze(profiles),
  });
}

function normalizeBaseUrl(raw: string, development: boolean, source: ConfigSource, variable?: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configError("invalid_base_url", source, variable);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw configError("invalid_base_url", source, variable);
  }
  const normalized = url.origin;
  if (normalized === DEFAULT_BASE_URL) return normalized;
  if (!development) throw configError("custom_origin_requires_development_profile", source, variable);
  const localHttp =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localHttp) throw configError("insecure_development_origin", source, variable);
  return normalized;
}

export async function resolveConfig(input: {
  readonly platform: PlatformAdapter;
  readonly env?: NodeJS.ProcessEnv;
  readonly overrides?: ConfigOverrides;
}): Promise<EffectiveConfig> {
  const env = input.env ?? process.env;
  const overrides = input.overrides ?? {};
  const joinPath = input.platform.kind === "windows" ? win32.join : posix.join;
  // Every configuration name below is derived from the brand authority in
  // `core/namespace.ts`, never written out here. A literal `CUNA_…` in this
  // file is how the rename narrowed four accepting surfaces at once.
  const explicitConfigFile = overrides.configFile ?? readBrandedEnvironment(env, "CONFIG_FILE")?.value;
  const preferredConfigFile = joinPath(input.platform.paths.configDirectory, "config.json");
  let configFile = explicitConfigFile ?? preferredConfigFile;
  let file = await input.platform.readSafeConfig(configFile, MAX_CONFIG_BYTES);
  const userConfig: UserConfig = file.exists
    ? parseUserConfig(file.text ?? "")
    : Object.freeze({ profiles: Object.freeze({}) });

  const profileEnvironment = readBrandedEnvironment(env, "PROFILE");
  let profile: string;
  let profileSource: ConfigSource;
  if (overrides.profile !== undefined) {
    profile = parseProfileName(overrides.profile, "flag");
    profileSource = "flag";
  } else if (profileEnvironment !== undefined) {
    profile = parseProfileName(profileEnvironment.value, "environment", profileEnvironment.name);
    profileSource = "environment";
  } else if (userConfig.selectedProfile !== undefined) {
    profile = userConfig.selectedProfile;
    profileSource = "profile";
  } else {
    profile = "default";
    profileSource = "default";
  }

  const selected = userConfig.profiles[profile];
  if (profile !== "default" && selected === undefined) throw configError("profile_not_found", profileSource);
  const developmentProfile = selected?.development === true;

  const baseUrlEnvironment = readBrandedEnvironment(env, "BASE_URL");
  let rawBaseUrl: string;
  let baseUrlSource: ConfigSource;
  let baseUrlVariable: string | undefined;
  if (overrides.baseUrl !== undefined) {
    rawBaseUrl = overrides.baseUrl;
    baseUrlSource = "flag";
  } else if (baseUrlEnvironment !== undefined) {
    rawBaseUrl = baseUrlEnvironment.value;
    baseUrlSource = "environment";
    baseUrlVariable = baseUrlEnvironment.name;
  } else if (selected?.baseUrl !== undefined) {
    rawBaseUrl = selected.baseUrl;
    baseUrlSource = "profile";
  } else {
    rawBaseUrl = DEFAULT_BASE_URL;
    baseUrlSource = "default";
  }

  const apiKeyEnvironment = readBrandedEnvironment(env, "API_KEY");
  const apiKeyUsable = apiKeyEnvironment !== undefined && isSecretApiKey(apiKeyEnvironment.value);
  const apiKeyProblem = apiKeyEnvironment !== undefined && !apiKeyUsable
    ? configError("invalid_api_key", "environment", apiKeyEnvironment.name)
    : undefined;
  const opencodeFeatureGate = resolveOpenCodeFeatureGate(env);
  return Object.freeze({
    platformKind: input.platform.kind,
    profile,
    profileSource,
    baseUrl: normalizeBaseUrl(rawBaseUrl, developmentProfile, baseUrlSource, baseUrlVariable),
    baseUrlSource,
    configFile,
    developmentProfile,
    apiKey: apiKeyUsable ? apiKeyEnvironment.value : undefined,
    apiKeySource: apiKeyEnvironment === undefined ? "absent" : "environment",
    apiKeyVariable: apiKeyEnvironment?.name,
    apiKeyProblem,
    opencodeFeatureGate,
  });
}

export function publicConfig(config: EffectiveConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    profile: config.profile,
    profile_source: config.profileSource,
    base_url: config.baseUrl,
    base_url_source: config.baseUrlSource,
    development_profile: config.developmentProfile,
    api_key: environmentCredentialState(config),
    api_key_source: config.apiKeySource,
    // Two spellings are accepted, so "which one did you read?" is a question a
    // user can now actually have. Reporting the name is not a disclosure: the
    // name is chosen by the caller and the value is never printed.
    api_key_variable: config.apiKeyVariable ?? null,
    opencode_feature: config.opencodeFeatureGate.state,
    opencode_feature_source: config.opencodeFeatureGate.source,
    opencode_feature_variable: config.opencodeFeatureGate.variable,
    config_file: config.configFile,
  });
}

import { posix, win32 } from "node:path";

import { EXIT_CODES, RunaError } from "../core/errors.js";
import { isObject } from "../core/validation.js";
import type { PlatformAdapter } from "../platform/adapter.js";

export const DEFAULT_BASE_URL = "https://api.runacode.io" as const;
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
}

interface ProfileRecord {
  readonly development: boolean;
  readonly baseUrl?: string;
}

interface UserConfig {
  readonly selectedProfile?: string;
  readonly profiles: Readonly<Record<string, ProfileRecord>>;
}

function configError(reason: string, source?: ConfigSource): RunaError {
  return new RunaError({
    code: "runa.config.invalid",
    message: "Runa configuration is invalid.",
    exitCode: EXIT_CODES.usage,
    hint: "Run `runa config get --json` after correcting the selected user profile.",
    details: { reason, ...(source === undefined ? {} : { source }) },
  });
}

function parseProfileName(value: string, source: ConfigSource): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw configError("invalid_profile_name", source);
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

function normalizeBaseUrl(raw: string, development: boolean, source: ConfigSource): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configError("invalid_base_url", source);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw configError("invalid_base_url", source);
  }
  const normalized = url.origin;
  if (normalized === DEFAULT_BASE_URL) return normalized;
  if (!development) throw configError("custom_origin_requires_development_profile", source);
  const localHttp =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localHttp) throw configError("insecure_development_origin", source);
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
  const configFile =
    overrides.configFile ?? env.RUNA_CONFIG_FILE ?? joinPath(input.platform.paths.configDirectory, "config.json");
  const file = await input.platform.readSafeConfig(configFile, MAX_CONFIG_BYTES);
  const userConfig: UserConfig = file.exists
    ? parseUserConfig(file.text ?? "")
    : Object.freeze({ profiles: Object.freeze({}) });

  let profile: string;
  let profileSource: ConfigSource;
  if (overrides.profile !== undefined) {
    profile = parseProfileName(overrides.profile, "flag");
    profileSource = "flag";
  } else if (env.RUNA_PROFILE !== undefined) {
    profile = parseProfileName(env.RUNA_PROFILE, "environment");
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

  let rawBaseUrl: string;
  let baseUrlSource: ConfigSource;
  if (overrides.baseUrl !== undefined) {
    rawBaseUrl = overrides.baseUrl;
    baseUrlSource = "flag";
  } else if (env.RUNA_BASE_URL !== undefined) {
    rawBaseUrl = env.RUNA_BASE_URL;
    baseUrlSource = "environment";
  } else if (selected?.baseUrl !== undefined) {
    rawBaseUrl = selected.baseUrl;
    baseUrlSource = "profile";
  } else {
    rawBaseUrl = DEFAULT_BASE_URL;
    baseUrlSource = "default";
  }

  const apiKey = env.RUNA_API_KEY;
  if (apiKey !== undefined && !/^runa_sk_[A-Za-z0-9_-]{16,256}$/u.test(apiKey)) {
    throw configError("invalid_api_key", "environment");
  }
  return Object.freeze({
    platformKind: input.platform.kind,
    profile,
    profileSource,
    baseUrl: normalizeBaseUrl(rawBaseUrl, developmentProfile, baseUrlSource),
    baseUrlSource,
    configFile,
    developmentProfile,
    apiKey,
    apiKeySource: apiKey === undefined ? "absent" : "environment",
  });
}

export function publicConfig(config: EffectiveConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    profile: config.profile,
    profile_source: config.profileSource,
    base_url: config.baseUrl,
    base_url_source: config.baseUrlSource,
    development_profile: config.developmentProfile,
    api_key: config.apiKey === undefined ? "absent" : "configured_not_validated",
    api_key_source: config.apiKeySource,
    config_file: config.configFile,
  });
}

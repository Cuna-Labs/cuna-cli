export type TerminalPresentationMode = "rich" | "plain" | "json";

export interface TerminalModeCapabilities {
  readonly interactive: boolean;
  readonly jsonRequested: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
  readonly reducedMotion: boolean;
  readonly rawMode: boolean;
  readonly alternateScreen: boolean;
  readonly vteConformance: "verified" | "unverified" | "unavailable";
}

export interface TerminalModeDecision {
  readonly mode: TerminalPresentationMode;
  readonly appbar: boolean;
  readonly reasons: readonly string[];
  readonly accessibility: "full" | "no_color" | "text_only" | "structured";
}

export function selectTerminalMode(capabilities: TerminalModeCapabilities): TerminalModeDecision {
  if (capabilities.jsonRequested || !capabilities.interactive) {
    return decision("json", false, [capabilities.jsonRequested ? "json_requested" : "noninteractive"], "structured");
  }
  const reasons: string[] = [];
  if (capabilities.columns < 40 || capabilities.rows < 4) reasons.push("terminal_too_small");
  if (!capabilities.color) reasons.push("color_unavailable");
  if (capabilities.reducedMotion) reasons.push("reduced_motion_requested");
  if (!capabilities.rawMode) reasons.push("raw_mode_unavailable");
  if (!capabilities.alternateScreen) reasons.push("alternate_screen_unavailable");
  if (capabilities.vteConformance !== "verified") reasons.push(`vte_${capabilities.vteConformance}`);
  if (reasons.length > 0) {
    return decision("plain", false, reasons, capabilities.color ? "text_only" : "no_color");
  }
  return decision("rich", true, [], "full");
}

function decision(
  mode: TerminalPresentationMode,
  appbar: boolean,
  reasons: readonly string[],
  accessibility: TerminalModeDecision["accessibility"],
): TerminalModeDecision {
  return Object.freeze({ mode, appbar, reasons: Object.freeze([...reasons]), accessibility });
}

export interface HostTerminalAdapter {
  enterRawMode(): void | Promise<void>;
  enterAlternateScreen(): void | Promise<void>;
  disableRemoteModes(): void | Promise<void>;
  leaveAlternateScreen(): void | Promise<void>;
  leaveRawMode(): void | Promise<void>;
}

export class HostTerminalLease {
  readonly #adapter: HostTerminalAdapter;
  #raw = false;
  #alternate = false;
  #restored = false;

  private constructor(adapter: HostTerminalAdapter) {
    this.#adapter = adapter;
  }

  static async acquire(adapter: HostTerminalAdapter): Promise<HostTerminalLease> {
    const lease = new HostTerminalLease(adapter);
    try {
      // Treat a throwing transition as potentially partially applied.
      lease.#raw = true;
      await adapter.enterRawMode();
      lease.#alternate = true;
      await adapter.enterAlternateScreen();
      return lease;
    } catch (error) {
      await lease.restore();
      throw error;
    }
  }

  async restore(): Promise<void> {
    if (this.#restored) return;
    this.#restored = true;
    const failures: unknown[] = [];
    try {
      await this.#adapter.disableRemoteModes();
    } catch (error) {
      failures.push(error);
    }
    if (this.#alternate) {
      try {
        await this.#adapter.leaveAlternateScreen();
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.#raw) {
      try {
        await this.#adapter.leaveRawMode();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Host terminal restoration was incomplete.");
  }
}

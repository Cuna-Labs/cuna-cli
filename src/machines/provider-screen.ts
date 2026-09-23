import type { CunaApiClient } from '../api/client.js';
import type { ProviderAgent, ProviderPreset, ProviderObservation } from '../api/provider-v2.js';
import { createNodeForegroundTerminalHost } from '../pty/node-host-terminal.js';
import type { ForegroundTerminalHost } from '../terminal/foreground.js';
import { sanitizeHumanTerminalOutput } from '../cli/output.js';
import { truncateTerminalLine } from '../terminal/cell-width.js';
import { machineHeader, paintMachinesExplorer } from './explorer.js';

/** The product name a person reads, and the account they sign in to inside it. */
const AGENTS: Readonly<Record<ProviderAgent, { readonly name: string; readonly signIn: string }>> = Object.freeze({
  'claude-code': { name: 'Claude Code', signIn: 'Claude' },
  codex: { name: 'Codex', signIn: 'Codex' },
  opencode: { name: 'OpenCode', signIn: 'OpenCode' },
});

export interface ProviderScreenOptions {
  /** Named in the one line printed when a single profile is used without asking. */
  readonly machineName?: string;
  readonly color?: boolean;
  /** Receives that one line. Absent: nothing is printed. */
  readonly announce?: (line: string) => void;
  /** Called once, immediately before the screen takes the terminal. */
  readonly onBeforeTerminalOwnership?: () => void;
}

/**
 * Preset mode: with exactly one profile nothing is asked (PRD cuna-cli-feel
 * R6) — one line says what happens next and that profile is returned without
 * taking the terminal. With several, a list drawn like the Machines view (R7).
 * Check mode: one explicit pull; expiry repaints locally and never polls.
 */
export async function runProviderScreen(
  client: CunaApiClient,
  mode: { kind: 'preset'; agent: ProviderAgent } | { kind: 'check'; sessionId: string },
  host: ForegroundTerminalHost = createNodeForegroundTerminalHost(),
  signal?: AbortSignal,
  options: ProviderScreenOptions = {},
): Promise<ProviderPreset | undefined> {
  let items: readonly ProviderPreset[] = [];
  let notice = '';
  let loaded = false;
  if (mode.kind === 'preset') {
    try {
      items = (await client.getProviderPresetsV2(signal)).filter((preset) => preset.agent === mode.agent);
      loaded = true;
    } catch {
      // Shown on the screen below, where `r` can try again.
    }
    if (signal?.aborted) return undefined;
    if (loaded && items.length === 1) {
      options.announce?.(singleProfileLine(items[0]!, options.machineName));
      return items[0];
    }
    if (loaded && items.length === 0) notice = ' No profiles are available for this agent yet. Press r to check again.';
    if (!loaded) notice = ' Your profiles could not be read. Press r to try again.';
  }

  options.onBeforeTerminalOwnership?.();
  const lease = await host.acquire('rich');
  const abort = new AbortController();
  let closed = false, busy = false, index = 0;
  let observation: ProviderObservation | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  let resolve!: (value: ProviderPreset | undefined) => void;
  const done = new Promise<ProviderPreset | undefined>((r) => { resolve = r; });
  const close = (value?: ProviderPreset) => { if (closed) return; closed = true; abort.abort(); resolve(value); };

  const render = () => {
    if (closed) return;
    const size = host.dimensions();
    const lines = mode.kind === 'preset' ? presetLines(mode.agent, items, index, options.machineName) : checkLines(observation);
    if (busy) lines.push('', mode.kind === 'preset' ? ' Reading your profiles…' : ' Checking…');
    if (notice) lines.push('', notice);
    lines.push('', mode.kind === 'preset'
      ? ` ↑↓ move  ·  Enter choose  ·  r refresh  ·  Esc/q back`
      : ` r check again  ·  Esc/q back`);
    const visible = lines.slice(0, Math.max(1, size.rows - 1))
      .map((line) => truncateTerminalLine(sanitizeHumanTerminalOutput(line), size.columns));
    const painted = paintMachinesExplorer(visible, size.columns, options.color ?? false);
    // Same frame discipline as the Machines view: synchronized update, cursor
    // hidden, every row cleared to its end, nothing left below.
    const frame = `\x1b[?2026h\x1b[?25l\x1b[H${painted.map((line) => `${line}\x1b[K`).join('\r\n')}\x1b[J\x1b[?2026l`;
    writes = writes.then(() => closed ? undefined : host.write(new TextEncoder().encode(frame))).catch(() => close());
  };

  const load = async () => {
    if (busy || closed) return;
    busy = true; observation = undefined; notice = '';
    if (timer) clearTimeout(timer);
    render();
    try {
      if (mode.kind === 'preset') {
        items = (await client.getProviderPresetsV2(abort.signal)).filter((preset) => preset.agent === mode.agent);
        index = 0;
        if (!items.length) notice = ' No profiles are available for this agent yet. Press r to check again.';
      } else {
        const session = await client.getAgentSession(mode.sessionId, abort.signal);
        if (!session.processEpoch) throw Error('scope');
        const result = await client.checkProviderV2(session.id, session.processEpoch, abort.signal);
        const current = await client.getAgentSession(session.id, abort.signal);
        if (current.processEpoch !== session.processEpoch || current.desiredState !== 'running' || !['ready', 'running'].includes(current.processState)) throw Error('scope');
        abort.signal.throwIfAborted();
        observation = result;
        if (result.state === 'observed') {
          timer = setTimeout(() => { observation = undefined; notice = ' This check expired. Press r to check again.'; render(); },
            Math.max(0, result.valid_until_ms - Date.now()));
        }
      }
    } catch {
      items = []; observation = undefined;
      notice = mode.kind === 'preset' ? ' Your profiles could not be read. Press r to try again.' : ' Provider information unavailable. Press r to try again.';
    } finally {
      busy = false; render();
    }
  };

  let sequence = '';
  let paste = false;
  const input = host.onInput((bytes) => {
    for (const byte of bytes) {
      if (sequence) {
        sequence += String.fromCharCode(byte);
        if (sequence === '\x1b[200~') { paste = true; sequence = ''; }
        else if (sequence === '\x1b[201~') { paste = false; sequence = ''; }
        else if (sequence === '\x1b[A' || sequence === '\x1b[B') {
          if (!paste && !busy) { index = Math.max(0, Math.min(items.length - 1, index + (sequence.endsWith('A') ? -1 : 1))); render(); }
          sequence = '';
        } else if (sequence.length > 8) sequence = '';
        continue;
      }
      if (byte === 27) { sequence = '\x1b'; setTimeout(() => { if (sequence === '\x1b') { sequence = ''; close(); } }, 50); continue; }
      // A pasted Enter is not a choice.
      if (paste) continue;
      if (byte === 3 || byte === 113) { close(); return; }
      if (byte === 114) void load();
      if ((byte === 13 || byte === 10) && !busy && mode.kind === 'preset' && items[index]) close(items[index]);
    }
  });
  const resize = host.onResize(render);
  const onAbort = () => close();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) close();
  else if (mode.kind === 'check') void load();
  else render();
  try { return await done; }
  finally {
    input(); resize();
    signal?.removeEventListener('abort', onAbort);
    if (timer) clearTimeout(timer);
    await writes;
    await lease.restore();
  }
}

/** The one line for R6: what opens, where, and what the person does next. */
export function singleProfileLine(preset: ProviderPreset, machineName?: string): string {
  const agent = AGENTS[preset.agent];
  const where = machineName === undefined ? 'your Machine' : sanitizeHumanTerminalOutput(machineName);
  return preset.kind === 'native_interactive'
    ? `${agent.name} will open on ${where}. Sign in to ${agent.signIn} inside the terminal.`
    : `${agent.name} will open on ${where} with ${sanitizeHumanTerminalOutput(preset.label)}. Connect your provider inside ${agent.name}.`;
}

function presetLines(agent: ProviderAgent, items: readonly ProviderPreset[], index: number, machineName?: string): string[] {
  const name = AGENTS[agent].name;
  const lines = [
    machineHeader(`New ${name} session`),
    ` Choose how ${name} starts${machineName === undefined ? '' : ` on ${machineName}`}.`,
    '',
  ];
  for (const [position, preset] of items.entries()) {
    lines.push(`${position === index ? '❯' : ' '} ${preset.label}`, `    ${presetDescription(preset)}`);
  }
  return lines;
}

function presetDescription(preset: ProviderPreset): string {
  const agent = AGENTS[preset.agent];
  return preset.kind === 'native_interactive'
    ? `Sign in to ${agent.signIn} inside the terminal after it opens.`
    : `Connect your provider and pick this model inside ${agent.name} after it opens.`;
}

function checkLines(observation: ProviderObservation | undefined): string[] {
  const lines = [machineHeader('Provider and model'), ''];
  if (observation?.state === 'observed' && observation.observed_at_ms <= Date.now() && observation.valid_until_ms > Date.now()) {
    lines.push(
      ` Provider: ${observation.provider.upstream_provider}`,
      ` Model: ${observation.provider.model}`,
      ` Agent version: ${observation.provider.agent_version}`,
      ` Valid until: ${new Date(observation.valid_until_ms).toISOString()}`,
    );
  } else {
    lines.push(' Provider and model unavailable.');
  }
  return lines;
}

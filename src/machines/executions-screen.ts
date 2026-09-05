import type { CunaApiClient } from "../api/client.js";
import type { ManagedExecution, ManagedExecutionPage } from "../api/managed-executions.js";
import { sanitizeHumanTerminalOutput } from "../cli/output.js";
import { CunaError } from "../core/errors.js";
import { assertMachineId } from "../core/validation.js";
import { createNodeForegroundTerminalHost } from "../pty/node-host-terminal.js";
import { terminalCellWidth, truncateTerminalLine } from "../terminal/cell-width.js";
import type { ForegroundTerminalHost } from "../terminal/foreground.js";
import { prepareManagedCommand, type CommandLaunchEnvironment, type PreparedCommand } from "./command-launch.js";
import { listExecutionReceipts, type ExecutionReceipt } from "./execution-receipt.js";

function wrappedLines(text: string, columns: number): string[] {
  const lines: string[] = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const source of text.split(/\r?\n/u)) {
    let line = "", width = 0;
    for (const { segment } of segmenter.segment(source.replaceAll("\t", "    "))) {
      const cells = terminalCellWidth(segment);
      if (line && width + cells > Math.max(1, columns - 1)) { lines.push(line); line = ""; width = 0; }
      line += segment; width += cells;
    }
    lines.push(line);
  }
  return lines;
}

/** Recovery never depends on availability of new command admission. */
export async function runExecutionsScreen(client: CunaApiClient, machineId: string,
  host: ForegroundTerminalHost = createNodeForegroundTerminalHost(), signal?: AbortSignal,
  launchEnvironment?: CommandLaunchEnvironment): Promise<"back" | "cancelled"> {
  assertMachineId(machineId);
  const lease = await host.acquire("rich");
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let page: ManagedExecutionPage | undefined, detail: ManagedExecution | undefined;
  let index = 0, busy = false, closed = false, confirm = false, notice = "";
  let cursor: string | undefined;
  const prior: (string | undefined)[] = [];
  let sequence = "", paste = false, escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  let prepared: PreparedCommand | undefined, commandText = "", commandConfirm = false, commandAttempted = false;
  let receiptPath = "", commandOutput = "", outputOffset = 0;
  let pastedCR = false, invalidInput = false;
  let commandOffset = 0, visibleCommandRows: string[] = [];
  let localMode = false, localItems: readonly ExecutionReceipt[] = [];
  const textDecoder = new TextDecoder();
  let finish!: (reason: "back" | "cancelled") => void;
  const done = new Promise<"back" | "cancelled">((resolve) => { finish = resolve; });
  const close = (reason: "back" | "cancelled") => {
    if (closed) return;
    closed = true; abort.abort(); finish(reason);
  };
  const render = () => {
    if (closed) return;
    const dimensions = host.dimensions();
    const lines = [" CUNA / Remote executions", ` Machine: ${machineId}`, ""];
    if (prepared !== undefined) {
      lines.push(` Execution: ${prepared.operationId}`, ...wrappedLines(` Remote cwd: ${prepared.workspace.remoteRoot}`, dimensions.columns),
        " Shell: /bin/sh -c on this remote Machine.", " Local files are not synchronized.");
      if (commandAttempted) {
        lines.push(receiptPath ? " Recovery ID saved on this computer." : " Preparing the command attempt.",
          " Exit status does not confirm descendant cleanup.",
          ` Inspect: cuna executions get ${prepared.operationId}`, `   --machine ${machineId}`);
        if (commandOutput) lines.push(...commandOutput.split(/\r?\n/u).slice(outputOffset, outputOffset + Math.max(1, dimensions.rows - 17)));
      } else {
        visibleCommandRows = wrappedLines(sanitizeHumanTerminalOutput(commandText), dimensions.columns);
        const count = Math.max(1, dimensions.rows - 15);
        commandOffset = Math.max(0, Math.min(commandOffset, visibleCommandRows.length - count));
        lines.push(" Command (kept only in memory):", ...visibleCommandRows.slice(commandOffset, commandOffset + count),
          ` Lines ${commandOffset + 1}-${Math.min(visibleCommandRows.length, commandOffset + count)} of ${visibleCommandRows.length}. ↑↓ scroll.`,
          commandConfirm ? " Enter sends once / Esc edits" : " Enter reviews / Esc returns. Paste never sends.");
      }
    } else if (detail !== undefined) {
      lines.push(` Execution: ${detail.operationId}`, ` Leader: ${detail.leaderState}`, ` Process ownership: ${detail.ownershipState}`,
        ` Workspace: ${detail.executionWorkspaceId ?? "legacy"}`, ` Exit code: ${detail.exitCode ?? "unobserved"}`,
        ` Cancellation requested: ${detail.cancelRequested ? "yes" : "no"}`,
        detail.ownershipState === "cleared" ? " Process ownership is cleared." : " Process cleanup is not confirmed.");
      if (detail.reason !== null) lines.push(` Reason: ${detail.reason}`);
      if (confirm) lines.push("", " Cancel this execution and its descendants?", " Enter confirms / Esc returns");
    } else if (localMode) {
      lines.push(" Saved attempts on this computer", " A saved ID does not prove the command reached the server.");
      if (localItems.length === 0) lines.push(" No saved attempts for this account and Machine.");
      const count = Math.max(1, dimensions.rows - 11), start = Math.max(0, index - count + 1);
      for (const [offset, item] of localItems.slice(start, start + count).entries()) {
        lines.push(`${start + offset === index ? " >" : "  "} ${item.operationId}`);
      }
    } else if (page !== undefined) {
      if (page.items.length === 0) lines.push(" No executions in this page.");
      const count = Math.max(1, Math.floor((dimensions.rows - 9) / 2));
      const start = Math.max(0, index - count + 1);
      for (const [offset, item] of page.items.slice(start, start + count).entries()) {
        lines.push(`${start + offset === index ? " >" : "  "} ${item.operationId}`,
          `   ${item.leaderState} / ${item.ownershipState}`);
      }
    }
    lines.push("", busy ? prepared !== undefined ? " Working… Ctrl+C closes observation; remote work may continue." : " Reading remote state… Ctrl+C closes observation." :
      prepared !== undefined ? commandAttempted ? " ↑↓ scroll output / r inspect attempt / Esc back / Ctrl+C close" : " Ctrl+C closes without sending." :
      detail !== undefined ? " r refresh / c cancel / Esc back / Ctrl+C close" :
        localMode ? " ↑↓ select / Enter inspect / r reload saved IDs / Esc remote list" :
        " ↑↓ select / Enter inspect / r refresh / n next / b previous / Esc back");
    if (!busy && prepared === undefined && detail === undefined && !localMode && launchEnvironment) lines.push(" x run command / l saved attempts");
    if (notice) lines.push(notice);
    const frame = "\x1b[H\x1b[2J" + lines.slice(0, Math.max(1, dimensions.rows - 1))
      .map(line => truncateTerminalLine(sanitizeHumanTerminalOutput(line), dimensions.columns)).join("\r\n");
    writes = writes.then(() => closed ? undefined : host.write(encoder.encode(frame))).catch(() => close("cancelled"));
  };
  const launch = async () => {
    if (busy || closed || launchEnvironment === undefined) return;
    busy = true; notice = ""; render();
    try {
      if (prepared === undefined) {
        prepared = await prepareManagedCommand(client, machineId, launchEnvironment, abort.signal);
        commandText = ""; commandConfirm = false; commandAttempted = false; receiptPath = ""; commandOutput = ""; outputOffset = 0;
        pastedCR = false; invalidInput = false; textDecoder.decode();
        commandOffset = 0;
      } else if (!commandAttempted) {
        commandAttempted = true;
        const result = await prepared.run(commandText, async path => {
          receiptPath = path; render(); await writes;
        }, abort.signal);
        commandOutput = sanitizeHumanTerminalOutput(result.stdout + (result.stderr ? "\n[stderr]\n" + result.stderr : ""));
        notice = ` Exit code: ${result.exitCode}.${result.stdoutTruncated || result.stderrTruncated ? " Output was truncated remotely." : ""} Press r to inspect process ownership.`;
      }
    } catch {
      notice = commandAttempted ? receiptPath ? " Command outcome is unconfirmed. Press r to inspect the saved execution ID; do not repeat it." :
        " Command was not sent. Could not confirm authority or save its recovery ID. Esc returns." :
        " Command launch is unavailable. Check the Machine, Workspace and account permissions.";
    } finally { commandText = commandAttempted ? "" : commandText; busy = false; render(); }
  };
  const perform = async (action: "list" | "inspect" | "cancel") => {
    if (busy || closed) return;
    const selectedReceipt = localMode ? localItems[index] : undefined;
    const selectedId = detail?.operationId ?? (localMode ? selectedReceipt?.operationId : page?.items[index]?.operationId);
    if (action !== "list" && selectedId === undefined) return;
    busy = true; notice = ""; render();
    try {
      if (action === "list") {
        if (localMode && launchEnvironment !== undefined) {
          const selected = localItems[index]?.operationId;
          localItems = [];
          const identity = await client.getIdentity(abort.signal);
          localItems = await listExecutionReceipts(launchEnvironment.platform,
            { baseUrl: launchEnvironment.baseUrl, profile: launchEnvironment.profile, userId: identity.id }, machineId, abort.signal);
          index = Math.max(0, localItems.findIndex(item => item.operationId === selected));
        } else {
        const selected = page?.items[index]?.operationId;
        page = await client.listManagedExecutions(machineId, cursor === undefined ? {} : { after: cursor }, abort.signal);
        index = Math.max(0, page.items.findIndex(item => item.operationId === selected));
        }
      } else {
        const observed = action === "cancel" ? await client.cancelManagedExecution(machineId, selectedId!, abort.signal) :
          await client.getManagedExecution(machineId, selectedId!, abort.signal);
        if (selectedReceipt !== undefined && observed.executionWorkspaceId !== selectedReceipt.executionWorkspaceId) {
          throw new Error("The server returned another Workspace for the saved execution ID.");
        }
        detail = observed;
        if (action === "cancel") notice = " Cancellation accepted. Refresh to observe cleanup.";
      }
    } catch (error) {
      // Keep the exact selected ID on uncertain cancellation; refresh observes it
      // without replaying the mutation or selecting a neighboring operation.
      notice = action === "cancel" ? " Cancellation not confirmed. Press r to inspect this execution." :
        localMode && action === "inspect" ? " No matching authoritative execution observed. ID retained; Enter inspects again without resending." :
        error instanceof CunaError ? error.message : " Could not read execution state. Press r to retry.";
    } finally {
      busy = false; confirm = false; render();
    }
  };
  const back = () => {
    if (busy) return;
    if (prepared !== undefined) {
      if (commandConfirm && !commandAttempted) commandConfirm = false;
      else { prepared = undefined; commandText = ""; commandOutput = ""; notice = ""; void perform("list"); }
      render();
    } else if (confirm) { confirm = false; render(); }
    else if (detail !== undefined) { detail = undefined; notice = ""; void perform("list"); }
    else if (localMode) { localMode = false; notice = ""; index = 0; void perform("list"); }
    else close("back");
  };
  const input = host.onInput(bytes => {
    for (const byte of bytes) {
      if (byte === 3) { close("cancelled"); return; }
      if (closed) return;
      if (sequence === "escape") {
        if (escapeTimer !== undefined) clearTimeout(escapeTimer);
        sequence = byte === 91 || byte === 79 ? "cursor" : "";
        continue;
      }
      if (sequence.startsWith("cursor")) {
        const char = String.fromCharCode(byte);
        if (!/[A-Za-z~]/u.test(char)) { sequence = sequence.length < 32 ? sequence + char : ""; continue; }
        if (sequence === "cursor200" && char === "~") paste = true;
        else if (sequence === "cursor201" && char === "~") paste = false;
        else if (!paste && !busy && prepared !== undefined && commandAttempted && (char === "A" || char === "B")) {
          outputOffset = Math.max(0, Math.min(commandOutput.split(/\r?\n/u).length - 1, outputOffset + (char === "A" ? -1 : 1))); render();
        } else if (!paste && !busy && prepared !== undefined && !commandAttempted && (char === "A" || char === "B")) {
          commandOffset += char === "A" ? -1 : 1; render();
        } else if (!paste && !busy && prepared === undefined && detail === undefined && (char === "A" || char === "B")) {
          index = Math.max(0, Math.min((localMode ? localItems.length : page?.items.length ?? 1) - 1, index + (char === "A" ? -1 : 1))); render();
        }
        sequence = ""; continue;
      }
      if (byte === 27) {
        sequence = "escape";
        escapeTimer = setTimeout(() => { sequence = ""; if (!paste) back(); }, 150);
        continue;
      }
      if (busy) continue;
      if (prepared !== undefined) {
        if (commandAttempted) {
          if (!paste && byte === 114) {
            const id = prepared.operationId;
            busy = true; notice = ""; render();
            void client.getManagedExecution(machineId, id, abort.signal).then(value => {
              if (value.executionWorkspaceId !== prepared?.workspace.executionWorkspaceId) throw new Error("Workspace mismatch");
              prepared = undefined; detail = value;
            }).catch(() => { notice = " Execution could not be observed. Press r to inspect the same ID again."; })
              .finally(() => { busy = false; render(); });
            return;
          }
          continue;
        }
        if (!paste && (byte === 13 || byte === 10)) {
          if (invalidInput) { notice = " Unsupported or oversized input. Esc returns; enter the command again."; render(); }
          else if (commandConfirm) void launch();
          else if (commandText.trim()) { commandConfirm = true; commandOffset = 0; render(); }
          return;
        }
        if (commandConfirm) continue;
        commandOffset = Number.MAX_SAFE_INTEGER;
        if (paste && byte === 10 && pastedCR) { pastedCR = false; continue; }
        pastedCR = paste && byte === 13;
        if (!paste && (byte === 127 || byte === 8)) commandText = Array.from(commandText).slice(0, -1).join("");
        else if (byte >= 32 && byte !== 127 || paste && (byte === 10 || byte === 13 || byte === 9)) {
          const decoded = textDecoder.decode(new Uint8Array([pastedCR ? 10 : byte]), { stream: true });
          if (/[\p{Cf}\u007f-\u009f\ufffd]/u.test(decoded) || Buffer.byteLength(commandText + decoded, "utf8") > 65536) invalidInput = true;
          else commandText += decoded;
        }
        continue;
      }
      if (paste) continue;
      if (byte === 108 && detail === undefined && launchEnvironment !== undefined && !localMode) {
        localMode = true; index = 0; localItems = []; void perform("list"); return;
      }
      if (byte === 120 && detail === undefined && launchEnvironment !== undefined && !localMode) { void launch(); return; }
      if (byte === 13 || byte === 10) { void perform(confirm ? "cancel" : "inspect"); return; }
      if (byte === 114 && !confirm) { void perform(detail === undefined ? "list" : "inspect"); return; }
      if (byte === 99 && detail !== undefined && !confirm) { confirm = true; notice = ""; render(); return; }
      if (byte === 110 && detail === undefined && !localMode && page?.nextCursor) {
        prior.push(cursor); cursor = page.nextCursor; page = undefined; index = 0; void perform("list"); return;
      }
      if (byte === 98 && detail === undefined && !localMode && prior.length) {
        cursor = prior.pop(); page = undefined; index = 0; void perform("list"); return;
      }
      if (byte === 127 || byte === 8) { back(); return; }
    }
    if (prepared !== undefined && !commandAttempted) render();
  });
  const resize = host.onResize(render);
  const onAbort = () => close("cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) close("cancelled"); else void perform("list");
  try { return await done; }
  finally {
    input(); resize(); signal?.removeEventListener("abort", onAbort);
    if (escapeTimer !== undefined) clearTimeout(escapeTimer);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([writes, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); await lease.restore(); }
  }
}

import type { CunaApiClient } from "../api/client.js";
import type { ManagedExecution, ManagedExecutionPage } from "../api/managed-executions.js";
import { sanitizeHumanTerminalOutput } from "../cli/output.js";
import { CunaError } from "../core/errors.js";
import { assertMachineId } from "../core/validation.js";
import { createNodeForegroundTerminalHost } from "../pty/node-host-terminal.js";
import { truncateTerminalLine } from "../terminal/cell-width.js";
import type { ForegroundTerminalHost } from "../terminal/foreground.js";

/** Recovery never depends on availability of new command admission. */
export async function runExecutionsScreen(client: CunaApiClient, machineId: string,
  host: ForegroundTerminalHost = createNodeForegroundTerminalHost(), signal?: AbortSignal): Promise<"back" | "cancelled"> {
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
    if (detail !== undefined) {
      lines.push(` Execution: ${detail.operationId}`, ` Leader: ${detail.leaderState}`, ` Process ownership: ${detail.ownershipState}`,
        ` Workspace: ${detail.executionWorkspaceId ?? "legacy"}`, ` Exit code: ${detail.exitCode ?? "unobserved"}`,
        ` Cancellation requested: ${detail.cancelRequested ? "yes" : "no"}`,
        detail.ownershipState === "cleared" ? " Process ownership is cleared." : " Process cleanup is not confirmed.");
      if (detail.reason !== null) lines.push(` Reason: ${detail.reason}`);
      if (confirm) lines.push("", " Cancel this execution and its descendants?", " Enter confirms / Esc returns");
    } else if (page !== undefined) {
      if (page.items.length === 0) lines.push(" No executions in this page.");
      const count = Math.max(1, Math.floor((dimensions.rows - 9) / 2));
      const start = Math.max(0, index - count + 1);
      for (const [offset, item] of page.items.slice(start, start + count).entries()) {
        lines.push(`${start + offset === index ? " >" : "  "} ${item.operationId}`,
          `   ${item.leaderState} / ${item.ownershipState}`);
      }
    }
    lines.push("", busy ? " Reading remote state… Ctrl+C closes observation." :
      detail !== undefined ? " r refresh / c cancel / Esc back / Ctrl+C close" :
        " ↑↓ select / Enter inspect / r refresh / n next / b previous / Esc back");
    if (notice) lines.push(notice);
    const frame = "\x1b[H\x1b[2J" + lines.slice(0, Math.max(1, dimensions.rows - 1))
      .map(line => truncateTerminalLine(sanitizeHumanTerminalOutput(line), dimensions.columns)).join("\r\n");
    writes = writes.then(() => closed ? undefined : host.write(encoder.encode(frame))).catch(() => close("cancelled"));
  };
  const perform = async (action: "list" | "inspect" | "cancel") => {
    if (busy || closed) return;
    const selectedId = detail?.operationId ?? page?.items[index]?.operationId;
    if (action !== "list" && selectedId === undefined) return;
    busy = true; notice = ""; render();
    try {
      if (action === "list") {
        const selected = page?.items[index]?.operationId;
        page = await client.listManagedExecutions(machineId, cursor === undefined ? {} : { after: cursor }, abort.signal);
        index = Math.max(0, page.items.findIndex(item => item.operationId === selected));
      } else {
        detail = action === "cancel" ? await client.cancelManagedExecution(machineId, selectedId!, abort.signal) :
          await client.getManagedExecution(machineId, selectedId!, abort.signal);
        if (action === "cancel") notice = " Cancellation accepted. Refresh to observe cleanup.";
      }
    } catch (error) {
      // Keep the exact selected ID on uncertain cancellation; refresh observes it
      // without replaying the mutation or selecting a neighboring operation.
      notice = action === "cancel" ? " Cancellation not confirmed. Press r to inspect this execution." :
        error instanceof CunaError ? error.message : " Could not read execution state. Press r to retry.";
    } finally {
      busy = false; confirm = false; render();
    }
  };
  const back = () => {
    if (busy) return;
    if (confirm) { confirm = false; render(); }
    else if (detail !== undefined) { detail = undefined; notice = ""; void perform("list"); }
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
        else if (!paste && !busy && detail === undefined && (char === "A" || char === "B")) {
          index = Math.max(0, Math.min((page?.items.length ?? 1) - 1, index + (char === "A" ? -1 : 1))); render();
        }
        sequence = ""; continue;
      }
      if (byte === 27) {
        sequence = "escape";
        escapeTimer = setTimeout(() => { sequence = ""; if (!paste) back(); }, 150);
        continue;
      }
      if (paste || busy) continue;
      if (byte === 13 || byte === 10) { void perform(confirm ? "cancel" : "inspect"); return; }
      if (byte === 114 && !confirm) { void perform(detail === undefined ? "list" : "inspect"); return; }
      if (byte === 99 && detail !== undefined && !confirm) { confirm = true; notice = ""; render(); return; }
      if (byte === 110 && detail === undefined && page?.nextCursor) {
        prior.push(cursor); cursor = page.nextCursor; page = undefined; index = 0; void perform("list"); return;
      }
      if (byte === 98 && detail === undefined && prior.length) {
        cursor = prior.pop(); page = undefined; index = 0; void perform("list"); return;
      }
      if (byte === 127 || byte === 8) { back(); return; }
    }
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

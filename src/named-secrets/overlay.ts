import { randomUUID } from "node:crypto";
import { SecretMaterial } from "../credentials/secret-material.js";
import { NamedSecretRequestError, validNamedSecretName, type NamedSecretContext, type NamedSecretReceipt } from "../api/named-secrets.js";
import type { NamedSecretService } from "./service.js";

export type SecretUiState = "CLOSED" | "EDIT_NAME" | "EDIT_SECRET" | "VALIDATING" | "SUBMITTING" | "RECONCILING" | "SUCCESS" | "ERROR" | "CLOSING";
export type SecretPersistence = "NOT_SENT" | "IN_FLIGHT" | "COMMITTED" | "REJECTED" | "UNKNOWN";
export interface SecretOverlayView { readonly name: string; readonly masked: string; readonly focus: "name" | "secret"; readonly feedback: string; readonly resizeRequired?: boolean; readonly revealed?: boolean; readonly revealedValue?: string; }
export interface SecretAuthority { readonly context: NamedSecretContext; readonly userId: string; }
const START = [27, 91, 50, 48, 48, 126];
const END = [27, 91, 50, 48, 49, 126];
function authorityKey(authority: SecretAuthority): string {
  const c = authority.context;
  const scope=c.workspace_binding_id===undefined?`execution:${c.execution_workspace_id}:${c.execution_workspace_generation}`:`binding:${c.workspace_binding_id}`;
  return `${authority.userId}:${c.agent_session_id}:${c.machine_id}:${scope}:${c.process_epoch}:${c.terminal_connection_id}:${c.writer_epoch}`;
}
/** Value storage is mutable and bounded; immutable JS/network copies cannot be guaranteed erased. */
export class NamedSecretOverlay {
  #state: SecretUiState = "CLOSED";
  #persistence: SecretPersistence = "NOT_SENT";
  #name = "";
  #secret = new Uint8Array(4096);
  #length = 0;
  #overflow = false;
  #invalidContent = false;
  #unsupportedContent = false;
  #focus: "name" | "secret" = "name";
  #revealed = false;
  #feedback = "Up/Down or Tab changes field · Enter saves · Esc cancels";
  #authorityKey = "";
  #operation: { id: string; name: string; workspaceId: string; userId: string; secretId?: string } | undefined;
  #generation = 0;
  #abort = new AbortController();
  #escape: number[] = [];
  #ignoredControl = false;
  #escapeTimer: ReturnType<typeof setTimeout> | undefined;
  #pasting = false;
  #pasteEnd: number[] = [];
  #task: Promise<void> | undefined;
  #disposed = false;
  #expired = false;
  #small = false;
  #plaintextTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #lifetimeMs: number;
  readonly #requestBudgetMs: number;
  constructor(readonly service: NamedSecretService, readonly authority: () => SecretAuthority | undefined, readonly changed: () => void,
    options: { plaintextLifetimeMs?: number; requestBudgetMs?: number; canEdit?: () => boolean } = {}) {
    this.#lifetimeMs = options.plaintextLifetimeMs ?? 120_000;
    this.#requestBudgetMs = options.requestBudgetMs ?? 10_000;
    this.#canEdit = options.canEdit ?? (() => true);
    if (![this.#lifetimeMs, this.#requestBudgetMs].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 300_000)) throw new RangeError("Named-secret lifetime budget is invalid.");
  }
  readonly #canEdit: () => boolean;
  geometryChanged(available: boolean, retainCapture = false): void {
    const changed = this.#small !== !available; this.#small = !available;
    if (this.#small && (this.active || retainCapture) && (this.#persistence === "NOT_SENT" && !this.#expired || retainCapture && !this.active)) {
      this.#generation += 1; this.#abort.abort(); this.#abort = new AbortController();
      this.#secret.fill(0); this.#length = 0; this.#name = ""; this.#expired = true; this.#revealed = false;
      if (this.#plaintextTimer !== undefined) clearTimeout(this.#plaintextTimer);
      this.#plaintextTimer = undefined; this.#state = "ERROR"; this.#feedback = "Input cleared · Esc closes";
      this.changed();
    } else if (changed && this.active) this.changed();
  }
  get active(): boolean { return this.#state !== "CLOSED"; }
  get state(): SecretUiState { return this.#state; }
  get persistence(): SecretPersistence { return this.#persistence; }
  get recoveryNotice(): string | undefined {
    return this.#operation !== undefined && (this.#persistence === "UNKNOWN" || this.#persistence === "IN_FLIGHT")
      ? `Named-secret outcome unknown. Check without writing again: cuna secrets operation ${this.#operation.id}` : undefined;
  }
  get view(): SecretOverlayView | undefined {
    const feedback = this.#small ? this.#persistence === "COMMITTED" ? "Saved · resize30x8" : this.#persistence === "UNKNOWN" ? "Unknown · resize30x8" : this.#persistence === "IN_FLIGHT" ? "Saving · resize30x8" : "Resize 30x8 · Esc" : this.#feedback;
    let characters = 0;
    for (let index = 0; index < this.#length; index += 1) {
      if ((this.#secret[index]! & 0xc0) !== 0x80) characters += 1;
    }
    return this.active ? Object.freeze({ name: this.#name, masked: "*".repeat(characters), focus: this.#focus, feedback,
      revealed: this.#revealed, ...(this.#revealed ? { revealedValue: new TextDecoder().decode(this.#secret.subarray(0, this.#length)) } : {}),
      ...(this.#small ? { resizeRequired: true } : {}) }) : undefined;
  }
  #setFocus(field: "name" | "secret"): void {
    if (!this.active || this.#persistence !== "NOT_SENT" || this.#state === "VALIDATING" || this.#expired || this.#small) return;
    this.#focus = field;
    this.#state = field === "name" ? "EDIT_NAME" : "EDIT_SECRET";
  }
  focusField(field: "name" | "secret"): void { this.#setFocus(field); this.changed(); }
  toggleReveal(): void {
    if (!this.active || this.#persistence !== "NOT_SENT" || this.#state === "VALIDATING" || this.#expired || this.#small) return;
    this.#revealed = !this.#revealed; this.changed();
  }
  open(): boolean {
    if (this.#disposed || this.active) return this.active;
    if (!this.#canEdit()) return false;
    this.#small = false;
    const authority = this.authority();
    const recovery = this.#operation !== undefined && (this.#persistence === "UNKNOWN" || this.#persistence === "IN_FLIGHT");
    if (authority === undefined && !recovery) return false;
    this.#authorityKey = authority === undefined ? "" : authorityKey(authority);
    this.#generation += 1;
    this.#abort = new AbortController();
    this.#focus = "name"; this.#revealed = false;
    if (this.#operation !== undefined && (this.#persistence === "UNKNOWN" || this.#persistence === "IN_FLIGHT")) {
      this.#name = this.#operation.name;
      this.#state = "ERROR";
      this.#feedback = "Outcome unknown · Enter checks the same operation";
    } else {
      this.#operation = undefined; this.#persistence = "NOT_SENT"; this.#name = ""; this.#state = "EDIT_NAME";
      this.#feedback = "Up/Down or Tab changes field · Enter saves · Esc cancels";
      this.#expired = false;
      this.#plaintextTimer = setTimeout(() => {
        if (this.#persistence !== "NOT_SENT" || !this.active) return;
        this.#generation += 1; this.#abort.abort(); this.#abort = new AbortController(); this.#clear(); this.#expired = true;
        this.#state = "ERROR"; this.#feedback = "Input expired · no write sent · Esc closes"; this.changed();
      }, this.#lifetimeMs);
    }
    this.changed(); return true;
  }
  /** Closing retains safe operation metadata, never a claim that an in-flight write rolled back. */
  close(): void {
    this.#state = "CLOSING";
    this.#generation += 1;
    this.#abort.abort();
    if (this.#persistence === "IN_FLIGHT") this.#persistence = "UNKNOWN";
    this.#clear(); this.#state = "CLOSED"; this.changed();
  }
  dispose(): void { this.close(); this.#disposed = true; }
  authorityChanged(): void {
    if (!this.active) return;
    const current = this.authority();
    if (current === undefined || authorityKey(current) !== this.#authorityKey) {
      this.#generation += 1; this.#abort.abort();
      this.#abort = new AbortController();
      this.#authorityKey = current === undefined ? "" : authorityKey(current);
      if (this.#persistence === "IN_FLIGHT") this.#persistence = "UNKNOWN";
      this.#clear(); this.#state = "ERROR";
      this.#expired = true;
      this.#feedback = this.#persistence === "UNKNOWN" ? "Connection changed · outcome unknown · Esc closes" : "Connection changed · no write sent · Esc closes";
      this.changed();
    }
  }
  /** A raw callback remains captured even if Escape closes midway through it. */
  input(bytes: Uint8Array): void {
    this.geometryChanged(this.#canEdit());
    for (const [index, byte] of bytes.entries()) {
      if (!this.active) break;
      if (this.#ignoredControl) {
        if (byte >= 64 && byte <= 126) this.#ignoredControl = false;
        continue;
      }
      if (this.#pasting) {
        if (this.#pasteEnd.length > 0 || byte === 27) {
          this.#pasteEnd.push(byte);
          if (this.#pasteEnd.every((item, index) => item === END[index])) {
            if (this.#pasteEnd.length === END.length) {
              this.#pasteEnd = []; this.#pasting = false;
              if (index + 1 < bytes.length) {
                this.#invalidContent = true; this.#feedback = "Paste boundary ambiguous · cancel and re-enter";
                break;
              }
            }
            continue;
          }
          for (const item of this.#pasteEnd) this.#append(item, true);
          this.#pasteEnd = [];
        } else this.#append(byte, true);
        continue;
      }
      if (this.#escape.length > 0 || byte === 27) {
        if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
        this.#escape.push(byte);
        const startsPaste = this.#escape.every((item, index) => item === START[index]);
        const endsPaste = this.#escape.every((item, index) => item === END[index]);
        if (startsPaste || endsPaste) {
          if (this.#escape.length === START.length) {
            this.#escape = [];
            if (startsPaste) this.#pasting = true;
            else { this.#invalidContent = true; this.#feedback = "Unexpected paste boundary · cancel and re-enter"; }
          }
          else if (this.#escape.length === 1) {
            this.#escapeTimer = setTimeout(() => { this.#escapeTimer = undefined; this.close(); }, 30);
          }
          continue;
        }
        if (this.#escape.length >= 3 && this.#escape[1] === 91) {
          if (this.#escape.length === 3) {
            if (byte === 65) this.#setFocus("name");
            else if (byte === 66) this.#setFocus("secret");
            else if (byte === 90) this.#setFocus(this.#focus === "name" ? "secret" : "name");
          }
          this.#escape = [];
          this.#ignoredControl = !(byte >= 64 && byte <= 126);
          continue;
        }
        if (this.#escape.length === 2 && this.#escape[1] === 79) continue;
        if (this.#escape.length === 3 && this.#escape[1] === 79) {
          if (byte === 65) this.#setFocus("name");
          else if (byte === 66) this.#setFocus("secret");
          this.#escape = []; continue;
        }
        this.close(); break;
      }
      if (byte === 3 || byte === 29) { this.close(); break; }
      if (byte === 9 && this.#persistence === "NOT_SENT" && this.#state !== "VALIDATING") {
        this.#setFocus(this.#focus === "name" ? "secret" : "name");
      } else if (byte === 13 || byte === 10) {
        if (this.#small) continue;
        if (this.#state === "SUCCESS" || this.#persistence === "REJECTED") { this.close(); break; }
        if (this.#task === undefined) {
          const task = this.#persistence === "UNKNOWN" ? this.#reconcile() : this.#submit();
          this.#task = task;
          void task.finally(() => { if (this.#task === task) this.#task = undefined; }).catch(() => undefined);
        }
      } else if ((byte === 127 || byte === 8) && this.#persistence === "NOT_SENT" && this.#state !== "VALIDATING") {
        if (this.#focus === "name") this.#name = this.#name.slice(0, -1);
        else if (this.#length > 0) {
          // Remove one UTF-8 scalar, including a partially received scalar.
          let start = this.#length - 1;
          while (start > 0 && (this.#secret[start]! & 0xc0) === 0x80) start -= 1;
          this.#secret.fill(0, start, this.#length); this.#length = start;
        }
      } else this.#append(byte, false);
    }
    this.changed();
  }
  #append(byte: number, paste: boolean): void {
    if (this.#expired || this.#persistence !== "NOT_SENT" || this.#state === "VALIDATING") return;
    if (this.#focus === "name") {
      if (byte >= 32 && byte <= 126 && /[A-Za-z0-9_.-]/u.test(String.fromCharCode(byte)) && this.#name.length < 64) this.#name += String.fromCharCode(byte);
      else this.#feedback = "Name uses letters, digits, dot, dash or underscore";
    } else if (paste && ((byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127)) {
      this.#secret.fill(0); this.#length = 0; this.#unsupportedContent = true;
      this.#feedback = "Terminal control sequences are unsupported · cancel and re-enter";
    } else if (!this.#unsupportedContent && (paste || byte >= 32 && byte !== 127)) {
      if (this.#length < this.#secret.length) this.#secret[this.#length++] = byte;
      else { this.#overflow = true; this.#feedback = "Password is limited to 4096 UTF-8 bytes"; }
    }
  }
  async #submit(): Promise<void> {
    this.geometryChanged(this.#canEdit());
    if (this.#expired || this.#small || this.#persistence !== "NOT_SENT" || !this.active) return;
    if (!validNamedSecretName(this.#name) || this.#length < 1 || this.#overflow || this.#invalidContent || this.#unsupportedContent) {
      this.#state = "ERROR"; this.#feedback = this.#unsupportedContent ? "Terminal control sequences are unsupported · cancel and re-enter" : this.#overflow ? "Password exceeded 4096 bytes · cancel and re-enter" : this.#invalidContent ? "Paste boundary ambiguous · cancel and re-enter" : "Enter a valid name and a nonempty password";
      this.#secret.fill(0); this.#length = 0; this.changed(); return;
    }
    try { new TextDecoder("utf-8", { fatal: true }).decode(this.#secret.subarray(0, this.#length)); }
    catch { this.#secret.fill(0); this.#length = 0; this.#state = "ERROR"; this.#feedback = "Password must be valid UTF-8"; this.changed(); return; }
    const current = this.authority();
    if (current === undefined || authorityKey(current) !== this.#authorityKey) { this.close(); return; }
    const generation = this.#generation;
    const signal = this.#abort.signal;
    this.#revealed = false;
    this.#state = "VALIDATING"; this.#feedback = "Checking vault authority…"; this.changed();
    let workspaceId: string;
    try { workspaceId = await this.#bounded((boundedSignal) => this.service.prepare(current.context, current.userId, boundedSignal), signal); }
    catch { if (generation === this.#generation) { this.#secret.fill(0); this.#length = 0; this.#state = "ERROR"; this.#feedback = "Vault authority unavailable · no write sent"; this.changed(); } return; }
    this.geometryChanged(this.#canEdit());
    if (generation !== this.#generation || signal.aborted || this.#small) return;
    const admitted = this.authority();
    if (admitted === undefined || authorityKey(admitted) !== this.#authorityKey) { this.close(); return; }
    const operation: { id: string; name: string; workspaceId: string; userId: string; secretId?: string } = { id: randomUUID(), name: this.#name, workspaceId, userId: admitted.userId };
    this.#operation = operation;
    const secret = SecretMaterial.fromBytes(this.#secret.subarray(0, this.#length));
    if (this.#plaintextTimer !== undefined) clearTimeout(this.#plaintextTimer);
    this.#plaintextTimer = undefined;
    this.#secret.fill(0); this.#length = 0;
    this.#state = "SUBMITTING"; this.#persistence = "IN_FLIGHT"; this.#feedback = "Saving…"; this.changed();
    try {
      const receipt = await this.#bounded((boundedSignal) => this.service.create(operation.id, operation.name, secret, admitted.context, boundedSignal), signal);
      if (receipt.operation_id !== operation.id) throw new NamedSecretRequestError();
      if (receipt.state === "rejected") { this.#reject(operation, generation, receipt.reason); return; }
      if (receipt.name !== operation.name || receipt.workspace_id !== workspaceId || receipt.secret_id === null) throw new NamedSecretRequestError();
      operation.secretId = receipt.secret_id;
      this.#persistence = "UNKNOWN";
    } catch (error) {
      if (error instanceof NamedSecretRequestError && error.status !== undefined && [401, 403, 409, 413, 422, 429].includes(error.status)) {
        this.#reject(operation, generation); return;
      }
      this.#persistence = "UNKNOWN";
    } finally { secret.dispose(); }
    if (generation === this.#generation && this.active) await this.#reconcile();
  }
  #reject(operation: { id: string }, generation: number, reason?: string): void {
    if (this.#operation?.id !== operation.id) return;
    this.#persistence = "REJECTED";
    if (generation === this.#generation && this.active) {
      this.#state = "ERROR";
      this.#feedback = reason === "named_secret_name_exists" ? "That secret name already exists · nothing overwritten"
        : reason === "named_secret_limit" ? "Vault capacity reached · nothing stored"
        : reason === "named_secret_context_denied" || reason === "named_secret_scope_denied" ? "Terminal or Workspace authority refused · nothing stored"
        : "Save refused · nothing stored";
      this.changed();
    }
  }
  async #reconcile(): Promise<void> {
    const operation = this.#operation;
    if (operation === undefined || !this.active) return;
    const generation = this.#generation;
    this.#state = "RECONCILING"; this.#feedback = "Checking durable confirmation…"; this.changed();
    try {
      // Bounded metadata-only reads; no replay of the password-bearing mutation.
      let receipt: NamedSecretReceipt | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { receipt = await this.#bounded((boundedSignal) => this.service.read(operation.id, boundedSignal, operation.userId), this.#abort.signal); break; }
        catch { if (this.#abort.signal.aborted) break; }
      }
      if (receipt === undefined || receipt.operation_id !== operation.id) throw new NamedSecretRequestError();
      if (receipt.state === "rejected") { this.#reject(operation, generation, receipt.reason); return; }
      if (receipt.name !== operation.name || receipt.workspace_id !== operation.workspaceId || receipt.secret_id === null ||
          operation.secretId !== undefined && receipt.secret_id !== operation.secretId) throw new NamedSecretRequestError();
      this.#persistence = "COMMITTED";
      if (generation === this.#generation && this.active) { this.#state = "SUCCESS"; this.#feedback = "Saved in Cuna · Enter or Esc returns"; }
    } catch {
      this.#persistence = "UNKNOWN";
      if (generation === this.#generation && this.active) { this.#state = "ERROR"; this.#feedback = "Outcome unknown · Enter checks the same operation"; }
    }
    this.changed();
  }
  #clear(): void {
    this.#secret.fill(0); this.#length = 0; this.#overflow = false; this.#invalidContent = false; this.#unsupportedContent = false; this.#name = ""; this.#escape = []; this.#ignoredControl = false; this.#pasteEnd = []; this.#pasting = false; this.#revealed = false;
    if (this.#escapeTimer !== undefined) clearTimeout(this.#escapeTimer);
    this.#escapeTimer = undefined;
    if (this.#plaintextTimer !== undefined) clearTimeout(this.#plaintextTimer);
    this.#plaintextTimer = undefined;
  }
  async #bounded<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let rejectBound: (error: NamedSecretRequestError) => void = () => undefined;
    const bound = new Promise<never>((_resolve, reject) => { rejectBound = reject; });
    const cancel = () => { controller.abort(); rejectBound(new NamedSecretRequestError()); };
    const timer = setTimeout(cancel, this.#requestBudgetMs);
    parent.addEventListener("abort", cancel, { once: true });
    try {
      if (parent.aborted) { cancel(); await bound; }
      return await Promise.race([operation(controller.signal), bound]);
    } finally { clearTimeout(timer); parent.removeEventListener("abort", cancel); }
  }
}

/** Tracks trusted host paste framing independently of the remote input queue.
 * Raw bytes cannot prove physical key provenance or disambiguate embedded delimiters.
 */
export class NamedSecretInputGate {
  #pasting = false; #start = 0; #end = 0;
  #wasModal = false;
  #mouse: number[] = [];
  get safeToEdit(): boolean { return !this.#pasting && this.#start === 0 && this.#mouse.length === 0; }
  get draining(): boolean { return this.#wasModal && !this.safeToEdit; }
  #track(bytes: Uint8Array, mouse?: (end: number, event: { button: number; column: number; row: number; release: boolean }) => void): void {
    for (const [index, byte] of bytes.entries()) {
      if (this.#pasting) {
        this.#end = byte === END[this.#end] ? this.#end + 1 : byte === END[0] ? 1 : 0;
        if (this.#end === END.length) { this.#pasting = false; this.#end = 0; }
      } else {
        if (this.#mouse.length > 0 || byte === 27) {
          this.#mouse.push(byte);
          const prefix = [27, 91, 60];
          if (this.#mouse.length <= 3 && !this.#mouse.every((item, at) => item === prefix[at])) this.#mouse = byte === 27 ? [27] : [];
          else if (this.#mouse.length > 3) {
            if (byte === 77 || byte === 109) {
              const match = /^\[<(\d{1,5});(\d{1,5});(\d{1,5})([Mm])$/u.exec(String.fromCharCode(...this.#mouse.slice(1)));
              if (match && Number(match[1]) <= 65535 && Number(match[2]) > 0 && Number(match[2]) <= 65535 && Number(match[3]) > 0 && Number(match[3]) <= 65535) {
                mouse?.(index + 1, { button: Number(match[1]), column: Number(match[2]), row: Number(match[3]), release: match[4] === "m" });
              }
              this.#mouse = [];
            } else if (this.#mouse.length > 24 || !(byte >= 48 && byte <= 57 || byte === 59)) this.#mouse = [];
          }
        }
        this.#start = byte === START[this.#start] ? this.#start + 1 : byte === START[0] ? 1 : 0;
        if (this.#start === START.length) { this.#pasting = true; this.#start = 0; this.#mouse = []; }
      }
    }
  }
  #local(bytes: Uint8Array, local: (bytes: Uint8Array) => void, mouse?: (event: { button: number; column: number; row: number; release: boolean }) => void): void {
    const reports: { end: number; event: { button: number; column: number; row: number; release: boolean } }[] = [];
    this.#track(bytes, (end, event) => reports.push({ end, event }));
    let start = 0;
    for (const report of reports) { local(bytes.subarray(start, report.end)); mouse?.(report.event); start = report.end; }
    if (start < bytes.length) local(bytes.subarray(start));
  }
  process(bytes: Uint8Array, active: () => boolean, open: () => void, local: (bytes: Uint8Array) => void, remote: (bytes: Uint8Array) => void, mouse?: (event: { button: number; column: number; row: number; release: boolean }) => void): void {
    if (active()) { this.#wasModal = true; this.#local(bytes, local, mouse); return; }
    if (this.#mouse.length > 0 && !this.#pasting) {
      const extendsReport = this.#mouse.length >= 3 || this.#mouse.length === 1 && bytes[0] === 91 || this.#mouse.length === 2 && bytes[0] === 60;
      if (extendsReport) { this.#track(bytes); this.#wasModal = !this.safeToEdit; return; }
      this.#mouse = [];
    }
    if (this.#wasModal && !this.#pasting && this.#start === 1 && bytes.length > 0 && bytes[0] !== START[1]) {
      // The preceding callback contained only the ambiguous Escape prefix.
      // A fresh callback which cannot extend host framing resumes normal routing.
      // A partially received CSI prefix and all input in the close callback still drain.
      this.#start = 0; this.#wasModal = false;
    }
    if (this.#wasModal && (this.#start > 0 || this.#pasting)) {
      // A lone Escape cancellation cannot prove that delayed bytes were not
      // the rest of a bracketed paste. Drain that ambiguous prefix and paste
      // locally across arbitrary callback gaps, including the whole end callback.
      for (const [index, byte] of bytes.entries()) {
        if (!this.#pasting && byte === 17) {
          this.#start = 0; this.#wasModal = false; open();
          if (active()) { this.#wasModal = true; const tail = bytes.subarray(index + 1); this.#local(tail, local, mouse); }
          return;
        }
        if (this.#pasting) {
          this.#track(Uint8Array.of(byte));
          if (!this.#pasting) { this.#wasModal = false; break; }
        } else if (byte === START[this.#start]) {
          this.#start += 1;
          if (this.#start === START.length) { this.#start = 0; this.#pasting = true; }
        } else { this.#start = 0; this.#wasModal = false; break; }
      }
      return;
    }
    this.#wasModal = false;
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index]!;
      if (this.#pasting) {
        this.#end = byte === END[this.#end] ? this.#end + 1 : byte === END[0] ? 1 : 0;
        if (this.#end === END.length) { this.#pasting = false; this.#end = 0; }
      } else {
        this.#start = byte === START[this.#start] ? this.#start + 1 : byte === START[0] ? 1 : 0;
        if (this.#start === START.length) { this.#pasting = true; this.#start = 0; }
        else if (byte === 17) {
          if (index > start) remote(bytes.subarray(start, index));
          open();
          // Once the chord is received the complete callback tail is quarantined,
          // including a refused open or Escape followed by remaining bytes.
          if (active()) { this.#wasModal = true; const tail = bytes.subarray(index + 1); this.#local(tail, local, mouse); }
          return;
        }
      }
    }
    if (bytes.length > start) remote(bytes.subarray(start));
  }
}

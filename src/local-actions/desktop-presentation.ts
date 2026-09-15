import { spawn } from "node:child_process";
import { dirname, isAbsolute, posix, win32 } from "node:path";

import type { LoopbackHost } from "./loopback.js";

const IDENTIFIER = /^[A-Za-z0-9._:@-]{1,256}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u;
const SAFE_IMAGE_MEDIA = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export type EditorId = "vscode" | "cursor" | "windsurf" | "zed" | "jetbrains-gateway";
export type PreviewPresentation = "image" | "text";

export interface PresentationBinding {
  readonly workspaceBindingId: string;
  readonly workspaceBindingGeneration: number;
}

export interface PreviewOpenArgs {
  readonly source:
    | { readonly kind: "artifact"; readonly opaqueId: string; readonly sha256: string }
    | { readonly kind: "private_forward"; readonly streamId: string };
  /** Untrusted hint; opening requires an exact match with the locally derived type. */
  readonly mediaType: string;
}

export interface DiffOpenArgs {
  readonly leftArtifactId: string;
  readonly rightArtifactId: string;
  readonly expectedDigests: readonly [string, string];
}

export interface EditorOpenArgs {
  readonly editor: EditorId;
  readonly connectionDescriptorId: string;
  readonly workspaceBindingId: string;
  readonly workspaceBindingGeneration: number;
}

export interface VerifiedPreviewArtifact extends PresentationBinding {
  readonly opaqueId: string;
  readonly localCopyPath: string;
  readonly sha256: string;
  /** Derived locally from verified bytes, never copied from the remote request. */
  readonly derivedMediaType: string;
}

export interface LivePrivateForward {
  readonly streamId: string;
  readonly localHost: LoopbackHost;
  readonly localPort: number;
  readonly expiresAt: number;
  /** Media type fixed by the approved local forward registration. */
  readonly derivedMediaType: string;
}

export interface VerifiedPresentationSourceResolver {
  resolveArtifact(input: {
    readonly opaqueId: string;
    readonly expectedSha256: string;
    readonly binding: PresentationBinding;
    readonly signal?: AbortSignal;
  }): Promise<VerifiedPreviewArtifact | null>;
  resolvePrivateForward(streamId: string, signal?: AbortSignal): Promise<LivePrivateForward | null>;
}

export interface StaticDesktopPresenter {
  openArtifact(input: {
    readonly localCopyPath: string;
    readonly verifiedMediaType: string;
    readonly presentation: PreviewPresentation;
    readonly scripts: "disabled";
    readonly network: "disabled";
    readonly navigation: "disabled";
    readonly forms: "disabled";
    readonly signal?: AbortSignal;
  }): Promise<void>;
  openPrivateForward(input: {
    readonly streamId: string;
    readonly localHost: LoopbackHost;
    readonly localPort: number;
    readonly verifiedMediaType: string;
    readonly presentation: PreviewPresentation;
    readonly followRedirects: false;
    readonly scripts: "disabled";
    readonly navigation: "disabled";
    readonly forms: "disabled";
    readonly signal?: AbortSignal;
  }): Promise<void>;
  openDiff(input: {
    readonly leftLocalCopyPath: string;
    readonly rightLocalCopyPath: string;
    readonly scripts: "disabled";
    readonly network: "disabled";
    readonly navigation: "disabled";
    readonly forms: "disabled";
    readonly signal?: AbortSignal;
  }): Promise<void>;
}

export interface EditorConnectionDescriptor extends PresentationBinding {
  readonly id: string;
  /** Local path supplied by the descriptor registry, never by the remote request. */
  readonly localWorkspacePath: string;
}

export interface EditorConnectionDescriptorResolver {
  resolve(id: string, signal?: AbortSignal): Promise<EditorConnectionDescriptor | null>;
}

export interface VerifiedEditorInstallation {
  readonly editor: EditorId;
  readonly absoluteExecutable: string;
  readonly verified: true;
}

export interface EditorInstallationResolver {
  resolve(editor: EditorId, signal?: AbortSignal): Promise<VerifiedEditorInstallation | null>;
}

export interface EditorLaunchCommand {
  readonly editor: EditorId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly localWorkspacePath: string;
}

export interface EditorProcessLauncher {
  launch(command: EditorLaunchCommand, signal?: AbortSignal): Promise<void>;
}

export interface DesktopPresentationActionsOptions {
  readonly sources: VerifiedPresentationSourceResolver;
  readonly presenter: StaticDesktopPresenter;
  readonly editorDescriptors: EditorConnectionDescriptorResolver;
  readonly editorInstallations: EditorInstallationResolver;
  readonly editorLauncher: EditorProcessLauncher;
  readonly now?: () => number;
}

export type DesktopOpenReceipt = Readonly<{ completed: true }>;
export type EditorOpenReceipt = Readonly<{ outcome: "opened" | "unsupported" }>;

export class DesktopPresentationError extends Error {
  public constructor(public readonly code: string) {
    super(`Cuna desktop presentation failed: ${code}.`);
    this.name = "DesktopPresentationError";
  }
}

export class DesktopPresentationActions {
  readonly #options: DesktopPresentationActionsOptions;
  readonly #now: () => number;

  public constructor(options: DesktopPresentationActionsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  public async openPreview(
    args: PreviewOpenArgs,
    binding: PresentationBinding,
    signal?: AbortSignal,
  ): Promise<DesktopOpenReceipt> {
    exactKeys(args, ["source", "mediaType"]);
    validateBinding(binding);
    validateMediaType(args.mediaType);
    throwIfAborted(signal);
    if (args.source.kind === "artifact") {
      exactKeys(args.source, ["kind", "opaqueId", "sha256"]);
      validateIdentifier(args.source.opaqueId);
      validateDigest(args.source.sha256);
      const artifact = await this.#options.sources.resolveArtifact({
        opaqueId: args.source.opaqueId,
        expectedSha256: args.source.sha256,
        binding: freezeBinding(binding),
        ...(signal === undefined ? {} : { signal }),
      });
      if (artifact === null || !sameBinding(artifact, binding) || artifact.opaqueId !== args.source.opaqueId ||
        artifact.sha256 !== args.source.sha256 || !absolutePath(artifact.localCopyPath) ||
        artifact.derivedMediaType !== args.mediaType) throw new DesktopPresentationError("artifact_verification_failed");
      await this.#options.presenter.openArtifact({
        localCopyPath: artifact.localCopyPath,
        verifiedMediaType: artifact.derivedMediaType,
        presentation: presentationFor(artifact.derivedMediaType),
        scripts: "disabled",
        network: "disabled",
        navigation: "disabled",
        forms: "disabled",
        ...(signal === undefined ? {} : { signal }),
      });
    } else if (args.source.kind === "private_forward") {
      exactKeys(args.source, ["kind", "streamId"]);
      validateIdentifier(args.source.streamId);
      const forward = await this.#options.sources.resolvePrivateForward(args.source.streamId, signal);
      if (forward === null || forward.streamId !== args.source.streamId || forward.expiresAt <= this.#now() ||
        (forward.localHost !== "127.0.0.1" && forward.localHost !== "::1") ||
        !validPort(forward.localPort) || forward.derivedMediaType !== args.mediaType) {
        throw new DesktopPresentationError("private_forward_unavailable");
      }
      await this.#options.presenter.openPrivateForward({
        streamId: forward.streamId,
        localHost: forward.localHost,
        localPort: forward.localPort,
        verifiedMediaType: forward.derivedMediaType,
        presentation: presentationFor(forward.derivedMediaType),
        followRedirects: false,
        scripts: "disabled",
        navigation: "disabled",
        forms: "disabled",
        ...(signal === undefined ? {} : { signal }),
      });
    } else throw new DesktopPresentationError("request_invalid");
    throwIfAborted(signal);
    return Object.freeze({ completed: true });
  }

  public async openDiff(
    args: DiffOpenArgs,
    binding: PresentationBinding,
    signal?: AbortSignal,
  ): Promise<DesktopOpenReceipt> {
    exactKeys(args, ["leftArtifactId", "rightArtifactId", "expectedDigests"]);
    validateBinding(binding);
    validateIdentifier(args.leftArtifactId);
    validateIdentifier(args.rightArtifactId);
    if (args.expectedDigests.length !== 2) throw new DesktopPresentationError("request_invalid");
    validateDigest(args.expectedDigests[0]);
    validateDigest(args.expectedDigests[1]);
    throwIfAborted(signal);
    const frozenBinding = freezeBinding(binding);
    const [left, right] = await Promise.all([
      this.#options.sources.resolveArtifact({
        opaqueId: args.leftArtifactId,
        expectedSha256: args.expectedDigests[0],
        binding: frozenBinding,
        ...(signal === undefined ? {} : { signal }),
      }),
      this.#options.sources.resolveArtifact({
        opaqueId: args.rightArtifactId,
        expectedSha256: args.expectedDigests[1],
        binding: frozenBinding,
        ...(signal === undefined ? {} : { signal }),
      }),
    ]);
    if (!verifiedDiffSide(left, args.leftArtifactId, args.expectedDigests[0], binding) ||
      !verifiedDiffSide(right, args.rightArtifactId, args.expectedDigests[1], binding)) {
      throw new DesktopPresentationError("artifact_verification_failed");
    }
    await this.#options.presenter.openDiff({
      leftLocalCopyPath: left.localCopyPath,
      rightLocalCopyPath: right.localCopyPath,
      scripts: "disabled",
      network: "disabled",
      navigation: "disabled",
      forms: "disabled",
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    return Object.freeze({ completed: true });
  }

  public async openEditor(
    args: EditorOpenArgs,
    binding: PresentationBinding,
    signal?: AbortSignal,
  ): Promise<EditorOpenReceipt> {
    exactKeys(args, ["editor", "connectionDescriptorId", "workspaceBindingId", "workspaceBindingGeneration"]);
    validateBinding(binding);
    validateEditor(args.editor);
    validateIdentifier(args.connectionDescriptorId);
    if (args.workspaceBindingId !== binding.workspaceBindingId ||
      args.workspaceBindingGeneration !== binding.workspaceBindingGeneration) {
      throw new DesktopPresentationError("workspace_binding_mismatch");
    }
    throwIfAborted(signal);
    const descriptor = await this.#options.editorDescriptors.resolve(args.connectionDescriptorId, signal);
    if (descriptor === null || descriptor.id !== args.connectionDescriptorId || !sameBinding(descriptor, binding) ||
      !absolutePath(descriptor.localWorkspacePath)) throw new DesktopPresentationError("descriptor_unavailable");
    const installation = await this.#options.editorInstallations.resolve(args.editor, signal);
    if (installation === null || installation.editor !== args.editor || installation.verified !== true) {
      return Object.freeze({ outcome: "unsupported" });
    }
    if (!absolutePath(installation.absoluteExecutable) || containsControl(installation.absoluteExecutable)) {
      throw new DesktopPresentationError("installation_invalid");
    }
    const command = renderEditorCommand(args.editor, installation.absoluteExecutable, descriptor.localWorkspacePath);
    await this.#options.editorLauncher.launch(command, signal);
    throwIfAborted(signal);
    return Object.freeze({ outcome: "opened" });
  }
}

export function createNodeEditorProcessLauncher(): EditorProcessLauncher {
  return Object.freeze({
    launch(command: EditorLaunchCommand, signal?: AbortSignal): Promise<void> {
      const expected = renderEditorCommand(command.editor, command.executable, command.localWorkspacePath);
      if (command.cwd !== expected.cwd || command.args.length !== expected.args.length ||
        command.args.some((argument, index) => argument !== expected.args[index])) {
        throw new DesktopPresentationError("launch_command_invalid");
      }
      return new Promise((resolve, reject) => {
        const child = spawn(command.executable, [...command.args], {
          cwd: command.cwd,
          detached: true,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
          ...(signal === undefined ? {} : { signal }),
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
  });
}

export function renderEditorCommand(editor: EditorId, executable: string, localWorkspacePath: string): EditorLaunchCommand {
  validateEditor(editor);
  if (!absolutePath(executable) || !absolutePath(localWorkspacePath) || containsControl(executable) || containsControl(localWorkspacePath)) {
    throw new DesktopPresentationError("launch_command_invalid");
  }
  const args = editor === "zed"
    ? [localWorkspacePath]
    : editor === "jetbrains-gateway"
      ? ["--project-path", localWorkspacePath]
      : ["--new-window", localWorkspacePath];
  return Object.freeze({
    editor,
    executable,
    args: Object.freeze(args),
    cwd: dirname(executable),
    localWorkspacePath,
  });
}

function presentationFor(mediaType: string): PreviewPresentation {
  return SAFE_IMAGE_MEDIA.has(mediaType) ? "image" : "text";
}

function verifiedDiffSide(
  artifact: VerifiedPreviewArtifact | null,
  opaqueId: string,
  digest: string,
  binding: PresentationBinding,
): artifact is VerifiedPreviewArtifact {
  return artifact !== null && artifact.opaqueId === opaqueId && artifact.sha256 === digest &&
    sameBinding(artifact, binding) && absolutePath(artifact.localCopyPath);
}

function validateBinding(binding: PresentationBinding): void {
  validateIdentifier(binding.workspaceBindingId);
  if (!Number.isSafeInteger(binding.workspaceBindingGeneration) || binding.workspaceBindingGeneration < 0) {
    throw new DesktopPresentationError("workspace_binding_invalid");
  }
}

function validateIdentifier(value: string): void {
  if (!IDENTIFIER.test(value)) throw new DesktopPresentationError("request_invalid");
}

function validateDigest(value: string): void {
  if (!DIGEST.test(value)) throw new DesktopPresentationError("request_invalid");
}

function validateMediaType(value: string): void {
  if (!MEDIA_TYPE.test(value)) throw new DesktopPresentationError("request_invalid");
}

function validateEditor(value: string): asserts value is EditorId {
  if (value !== "vscode" && value !== "cursor" && value !== "windsurf" && value !== "zed" && value !== "jetbrains-gateway") {
    throw new DesktopPresentationError("request_invalid");
  }
}

function sameBinding(left: PresentationBinding, right: PresentationBinding): boolean {
  return left.workspaceBindingId === right.workspaceBindingId &&
    left.workspaceBindingGeneration === right.workspaceBindingGeneration;
}

function freezeBinding(binding: PresentationBinding): PresentationBinding {
  return Object.freeze({
    workspaceBindingId: binding.workspaceBindingId,
    workspaceBindingGeneration: binding.workspaceBindingGeneration,
  });
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function absolutePath(value: string): boolean {
  return (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value)) && !containsControl(value);
}

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0)!;
    return point <= 0x1f || point === 0x7f;
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DesktopPresentationError("cancelled");
}

function exactKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new DesktopPresentationError("request_invalid");
  }
}

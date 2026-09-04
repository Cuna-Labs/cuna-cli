// Generated from contracts/terminal-wire/runa-terminal-v1.json. Do not edit.
// Verify with contracts/tools/generate-terminal-wire.mjs --check --output <this-file>.
export const TERMINAL_WIRE_TABLE_SHA256 = "e2f528613f039a5ba4a4bcbced16e7c5f8e080ad7e2c73ce9d89a7dc13e0faf3" as const;
export const TERMINAL_WIRE_PROTOCOL = "runa.terminal.v1" as const;
export const TERMINAL_FRAME_TYPES = Object.freeze({
  ready: 1,
  input: 2,
  output: 3,
  resize: 4,
  signal: 5,
  heartbeat: 6,
  exit: 7,
  error: 8,
  acknowledgement: 9,
  resume: 10,
  local_action_request: 11,
  local_action_result: 12,
  local_stream_open: 13,
  local_stream_data: 14,
  local_stream_close: 15,
  local_stream_window_update: 16,
  writer_epoch: 17,
} as const);
export type TerminalFrameType = keyof typeof TERMINAL_FRAME_TYPES;

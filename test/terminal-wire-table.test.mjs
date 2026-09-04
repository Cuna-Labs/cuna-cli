import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { encodeTerminalFrame, decodeTerminalFrame } from '../dist/terminal/codec.js';

const names = ['ready', 'input', 'output', 'resize', 'signal', 'heartbeat', 'exit', 'error',
  'acknowledgement', 'resume', 'local_action_request', 'local_action_result', 'local_stream_open',
  'local_stream_data', 'local_stream_close', 'local_stream_window_update', 'writer_epoch'];

test('CLI codec consumes the generated frame table', async () => {
  const source = await readFile(new URL('../src/terminal/codec.ts', import.meta.url), 'utf8');
  assert.match(source, /import\s*\{\s*TERMINAL_FRAME_TYPES\s*\}\s*from "\.\/generated\/terminal-wire-v1\.js"/u);
  assert.doesNotMatch(source, /TERMINAL_FRAME_TYPES\s*=\s*Object\.freeze/u);
});

test('all seventeen RTP1 literal wire codes roundtrip through the actual CLI codec', () => {
  for (const [index, type] of names.entries()) {
    const hex = '525450310101' + (index + 1).toString(16).padStart(4, '0') + '0102030405060708' + '00000004' + '00ff4142';
    const encoded = encodeTerminalFrame({ type, critical: true, sequence: 0x0102030405060708n, payload: Uint8Array.of(0, 255, 65, 66) });
    assert.equal(Buffer.from(encoded).toString('hex'), hex, type);
    const decoded = decodeTerminalFrame(Buffer.from(hex, 'hex'));
    assert.equal(decoded.type, type);
    assert.equal(decoded.sequence, 0x0102030405060708n);
    assert.equal(decoded.critical, true);
    assert.deepEqual([...decoded.payload], [0, 255, 65, 66]);
  }
});

test('unknown critical and noncritical frame handling remains unchanged', () => {
  const wire = Buffer.from('52545031010100ff000000000000000100000000', 'hex');
  assert.throws(() => decodeTerminalFrame(wire), { code: 'unknown_critical_frame' });
  wire[5] = 0;
  assert.equal(decodeTerminalFrame(wire), undefined);
});

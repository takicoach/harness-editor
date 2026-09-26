import { expect, it } from 'vitest';
import { startFrameEncoder } from './exportRunner';

it('reports why FFmpeg stopped instead of the closed pipe', async () => {
  const encoder = startFrameEncoder(process.execPath, ['-e', "process.stderr.write('Invalid PNG signature\\n');process.exit(1)"], new AbortController().signal);
  const frame = Buffer.alloc(256 * 1024);
  let failure: unknown;
  try { for (let i = 0; i < 200 && !failure; i++) await encoder.write(frame).catch(error => { failure = error; }); }
  finally { await encoder.stop(); }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/^動画の符号化に失敗しました: Invalid PNG signature/);
});

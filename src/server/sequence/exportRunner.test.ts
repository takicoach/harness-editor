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

it('names the export retention in the drawing page URL, and only when there is one', async () => {
  const { exportRenderPageUrl, exportRetainFrames } = await import('./exportRunner');
  const { EXPORT_RETAIN_FRAMES } = await import('../../preview/native/exportSourceRelease');
  const target = { projectId: 'p q', jobId: 'j' };
  expect(exportRenderPageUrl('http://h', target, 8)).toBe('http://h/native-render.html?id=p+q&job=j&retain=8');
  expect(exportRenderPageUrl('http://h', target, 0)).toBe('http://h/native-render.html?id=p+q&job=j');
  expect(exportRenderPageUrl('http://h', target)).toBe('http://h/native-render.html?id=p+q&job=j');
  // The product always passes the export value; only the measuring tool overrides it (0 = earlier behaviour).
  expect(exportRetainFrames(undefined)).toBe(EXPORT_RETAIN_FRAMES);
  expect(exportRetainFrames({})).toBe(EXPORT_RETAIN_FRAMES);
  expect(exportRetainFrames({ retainFrames: 16 })).toBe(16);
  expect(exportRetainFrames({ retainFrames: 0 })).toBe(0);
});

it('says when FFmpeg exits on its own, so an export waiting for a slow frame notices at once', async () => {
  const crashed = startFrameEncoder(process.execPath, ['-e', "process.stderr.write('out of memory\\n');process.exit(3)"], new AbortController().signal);
  await expect(crashed.closed).rejects.toThrow(/^動画の符号化に失敗しました: out of memory/);
  const clean = startFrameEncoder(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'], new AbortController().signal);
  let exited = false; void clean.closed.then(() => { exited = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(exited).toBe(false);
  await clean.finish(); await clean.closed;
});

// FFmpeg blocked reading PNGs from the pipe does not act on SIGTERM until its read returns; ending its
// input on a stop lets it exit at once instead of after the 5-second SIGKILL fallback.
it('stops an encoder that is waiting for input promptly', async () => {
  const encoder = startFrameEncoder(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 200));
  const began = performance.now();
  encoder.kill(); await encoder.stop();
  expect(performance.now() - began).toBeLessThan(2000);
});

import { expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeExportFile } from './exportVerification';

it.skipIf(process.platform === 'win32')('stops a stalled FFprobe and says which check ran out of time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'export-probe-')), ffprobe = join(directory, 'ffprobe');
  try {
    await writeFile(ffprobe, '#!/bin/sh\nsleep 5\n'); await chmod(ffprobe, 0o755);
    const started = Date.now();
    await expect(probeExportFile(ffprobe, join(directory, 'output.mp4'), { maxBuffer: 1024, timeout: 200 })).rejects.toThrow(/FFprobe が 0\.2 秒以内に終わりませんでした/);
    expect(Date.now() - started).toBeLessThan(4000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it.skipIf(process.platform === 'win32')('keeps a cancellation distinguishable from a timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'export-probe-')), ffprobe = join(directory, 'ffprobe'), controller = new AbortController();
  try {
    await writeFile(ffprobe, '#!/bin/sh\nsleep 5\n'); await chmod(ffprobe, 0o755);
    const probe = probeExportFile(ffprobe, join(directory, 'output.mp4'), { maxBuffer: 1024, signal: controller.signal });
    controller.abort();
    await expect(probe).rejects.toMatchObject({ name: 'AbortError' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('accepts the canvas engine stream only without reordered frames, since FFmpeg stamps frame n at n × den/num', async () => {
  const { verifyNoFrameReordering } = await import('./exportVerification');
  const probe = (video: Record<string, unknown>) => ({ streams: [{ codec_type: 'video', codec_name: 'h264', ...video }, { codec_type: 'audio', codec_name: 'aac' }] });
  expect(() => verifyNoFrameReordering(probe({ has_b_frames: 0 }))).not.toThrow();
  for (const video of [{ has_b_frames: 2 }, { has_b_frames: 1 }, {}])
    expect(() => verifyNoFrameReordering(probe(video))).toThrow('書き出した映像にコマの並べ替えが含まれています');
  expect(() => verifyNoFrameReordering({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] })).toThrow('書き出した映像にコマの並べ替えが含まれています');
});

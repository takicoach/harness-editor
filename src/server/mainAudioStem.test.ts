import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MainAudioFilterInput } from './mainAudioFilter';
import { buildMainAudioStem } from './mainAudioStem';

const FFMPEG = process.env.HARNESS_TEST_FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const runnable = existsSync(FFMPEG);
const baseline = { gainDb: 0, muted: false, fadeInFrames: 0, fadeOutFrames: 0 };

function input(hasAudio = true): MainAudioFilterInput {
  return {
    fps: 30,
    totalFrames: 30,
    hasAudio,
    settings: baseline,
    segments: [{ originalStart: 0, originalEnd: 30, finalStart: 0, durationFrames: 30, playbackRate: 1 }],
  };
}

function decodeFloatStereo(path: string): Buffer {
  return execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', path,
    '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
  ], { maxBuffer: 2 * 1024 * 1024 });
}

async function waitForProcessContaining(fragment: string): Promise<{ pid: number; command: string }> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const match = processes.split('\n').find(line => line.includes(fragment))?.match(/^\s*(\d+)/);
    if (match?.[1] !== undefined) {
      const command = processes.split('\n').find(line => line.includes(fragment))!;
      return { pid: Number(match[1]), command };
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`ffmpeg did not start with input ${fragment}`);
}

describe.skipIf(!runnable)('buildMainAudioStem (real ffmpeg)', () => {
  let root = '';
  let ownedBase = '';
  let source = '';
  let silentVideo = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'main-audio-stem-test-'));
    ownedBase = join(root, 'owned');
    mkdirSync(ownedBase);
    source = join(root, 'source.wav');
    silentVideo = join(root, 'silent.mkv');
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'aevalsrc=0.25|-0.125:s=48000:d=1', '-c:a', 'pcm_f32le', '-y', source,
    ]);
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'color=c=black:s=16x16:r=30:d=1', '-an', '-c:v', 'ffv1', '-y', silentVideo,
    ]);
  });

  afterAll(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  it('writes an exact-length 48 kHz stereo float stem and transfers idempotent cleanup ownership', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = await buildMainAudioStem({
      sourcePath: source,
      filterInput: input(),
      signal: controller.signal,
      ffmpegPath: FFMPEG,
      tempBasePath: ownedBase,
    });

    expect(result.stemPath.startsWith(`${ownedBase}/`)).toBe(true);
    expect(existsSync(result.stemPath)).toBe(true);
    const raw = decodeFloatStereo(result.stemPath);
    expect(raw.length).toBe(48_000 * 2 * 4);
    const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', result.stemPath, '-f', 'null', '-'], { encoding: 'utf8' });
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stderr).toMatch(/Audio: pcm_f32le.*48000 Hz, stereo/);
    let maxError = 0;
    for (let frame = 0; frame < 48_000; frame++) {
      maxError = Math.max(
        maxError,
        Math.abs(raw.readFloatLE(frame * 8) - 0.25),
        Math.abs(raw.readFloatLE(frame * 8 + 4) + 0.125),
      );
    }
    expect(maxError).toBeLessThan(1e-6);
    expect(remove).toHaveBeenCalledTimes(1);

    controller.abort();
    expect(existsSync(result.stemPath)).toBe(true);
    const releasedDirectory = dirname(result.stemPath);
    result.cleanup();
    expect(existsSync(releasedDirectory)).toBe(false);
    mkdirSync(releasedDirectory);
    result.cleanup();
    expect(existsSync(releasedDirectory)).toBe(true);
    rmSync(releasedDirectory, { recursive: true });
  });

  it('creates exact silence from a source with no audio when hasAudio is false', async () => {
    const result = await buildMainAudioStem({
      sourcePath: silentVideo,
      filterInput: input(false),
      signal: new AbortController().signal,
      ffmpegPath: FFMPEG,
      tempBasePath: ownedBase,
    });
    try {
      const raw = decodeFloatStereo(result.stemPath);
      expect(raw.length).toBe(48_000 * 2 * 4);
      expect(raw.every(byte => byte === 0)).toBe(true);
    } finally {
      result.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32')('terminates a running ffmpeg on abort, waits for it, and removes partial resources', async () => {
    const fifo = join(root, 'blocking-source.wav');
    const fifoResult = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    expect(fifoResult.status, fifoResult.stderr).toBe(0);
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = buildMainAudioStem({
      sourcePath: fifo,
      filterInput: input(),
      signal: controller.signal,
      ffmpegPath: FFMPEG,
      tempBasePath: ownedBase,
    });
    const running = await waitForProcessContaining(fifo);
    expect(running.command).toContain('-/filter_complex');
    expect(running.command).toContain(join(ownedBase, 'main-audio-'));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(() => process.kill(running.pid, 0)).toThrow();
    expect(readdirSync(ownedBase)).toEqual([]);
  });

  it('fails closed on a real ffmpeg input error and removes its filter/output directory', async () => {
    await expect(buildMainAudioStem({
      sourcePath: join(root, 'missing.wav'),
      filterInput: input(),
      signal: new AbortController().signal,
      ffmpegPath: FFMPEG,
      tempBasePath: ownedBase,
    })).rejects.toThrow(/ffmpeg failed.*missing\.wav/s);
    expect(readdirSync(ownedBase)).toEqual([]);
  });

  it('allocates nothing when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildMainAudioStem({
      sourcePath: source,
      filterInput: input(),
      signal: controller.signal,
      ffmpegPath: FFMPEG,
      tempBasePath: ownedBase,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(readdirSync(ownedBase)).toEqual([]);
  });
});

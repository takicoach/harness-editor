import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMainAudioStem } from './mainAudioStem';
import { createRenderInputSnapshot } from './renderInputSnapshot';

const FFMPEG = process.env.HARNESS_TEST_FFMPEG ?? '/opt/homebrew/bin/ffmpeg';

function decodeFirstLeftSample(path: string): number {
  const raw = execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', path,
    '-map', '0:a:0', '-frames:a', '1', '-ar', '48000', '-ac', '2',
    '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
  ]);
  return raw.readFloatLE(0);
}

function writeTone(path: string, amplitude: number): void {
  execFileSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `aevalsrc=${amplitude}|${amplitude}:s=48000:d=1`,
    '-c:a', 'pcm_f32le', '-y', path,
  ]);
}

describe.skipIf(!existsSync(FFMPEG))('snapshot to real main-audio stem independent audit', () => {
  let root = '';
  afterEach(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('builds from the successful snapshot even after the same-size original is replaced', async () => {
    root = mkdtempSync(join(tmpdir(), 'sme-stem-snapshot-audit-'));
    const project = join(root, 'project');
    const snapshots = join(root, 'snapshots');
    const stems = join(root, 'stems');
    mkdirSync(join(project, 'public'), { recursive: true });
    mkdirSync(snapshots);
    mkdirSync(stems);
    const relativeSource = 'public/source.wav';
    const original = join(project, relativeSource);
    writeTone(original, 0.125);
    const originalTimes = statSync(original);

    const snapshot = await createRenderInputSnapshot({
      projectDir: project,
      files: [relativeSource],
      signal: new AbortController().signal,
      tempRoot: snapshots,
    });
    writeTone(original, -0.125);
    utimesSync(original, originalTimes.atime, originalTimes.mtime);
    expect(statSync(original).size).toBe(statSync(join(snapshot.projectDir, relativeSource)).size);

    const stem = await buildMainAudioStem({
      sourcePath: join(snapshot.projectDir, relativeSource),
      filterInput: {
        fps: 30,
        totalFrames: 30,
        hasAudio: true,
        settings: { gainDb: 0, muted: false, fadeInFrames: 0, fadeOutFrames: 0 },
        segments: [{ originalStart: 0, originalEnd: 30, finalStart: 0, durationFrames: 30, playbackRate: 1 }],
      },
      signal: new AbortController().signal,
      ffmpegPath: FFMPEG,
      tempBasePath: stems,
    });
    try {
      expect(decodeFirstLeftSample(stem.stemPath)).toBeCloseTo(0.125, 5);
      expect(decodeFirstLeftSample(original)).toBeCloseTo(-0.125, 5);
      expect(readFileSync(join(snapshot.projectDir, relativeSource))).not.toEqual(readFileSync(original));
    } finally {
      stem.cleanup();
      snapshot.cleanup();
    }
    expect(existsSync(snapshot.projectDir)).toBe(false);
    expect(existsSync(stem.stemPath)).toBe(false);
  });
});

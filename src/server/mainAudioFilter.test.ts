import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMainAudioFilter, type MainAudioFilterInput } from './mainAudioFilter';

const baseline = { gainDb: 0, muted: false, fadeInFrames: 0, fadeOutFrames: 0 };
let directory: string;
function ffmpeg(args: string[]) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(String(result.error ?? result.stderr));
  return result.stdout;
}
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'main-audio-filter-'));
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=480:sample_rate=48000:duration=6', '-c:a', 'pcm_f32le', join(directory, 'source.wav')]);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function render(input: MainAudioFilterInput, name: string, source = 'source.wav', channels = 1) {
  const plan = buildMainAudioFilter(input), filter = join(directory, `${name}.txt`), output = join(directory, `${name}.wav`);
  writeFileSync(filter, plan.filter);
  ffmpeg(['-i', join(directory, source), '-/filter_complex', filter, '-map', '[mainaudio]', '-ar', '48000', '-c:a', 'pcm_f32le', output]);
  const pcm = ffmpeg(['-i', output, '-ac', String(channels), '-f', 'f32le', 'pipe:1']);
  const samples = Float32Array.from({ length: pcm.length / 4 }, (_, index) => pcm.readFloatLE(index * 4));
  expect(samples.length).toBe(Math.round(input.totalFrames * 48000 / input.fps) * channels);
  expect(readFileSync(output).length).toBeGreaterThan(44);
  return samples;
}
describe('sample-aligned main audio stem', () => {
  for (const rate of [1, 1.5]) {
    for (const overlap of [false, true]) {
      it(`preserves samples, phase and global fade at ${rate}x / overlap ${overlap}`, () => {
        const length = rate === 1 ? 60 : 40, overlapFrames = overlap ? (rate === 1 ? 15 : 10) : 0;
        const secondStart = length - overlapFrames, totalFrames = length * 2 - overlapFrames;
        const input: MainAudioFilterInput = { fps: 30, totalFrames, hasAudio: true, settings: baseline, segments: [
          { originalStart: 0, originalEnd: 60, finalStart: 0, durationFrames: length, playbackRate: rate },
          { originalStart: 120, originalEnd: 180, finalStart: secondStart, durationFrames: length, playbackRate: rate },
        ] };
        const name = `${rate}-${overlap}`, reference = render(input, `${name}-unity`);
        const adjusted = render({ ...input, settings: { ...baseline, gainDb: 6, fadeInFrames: 30, fadeOutFrames: 30 } }, `${name}-fade`);
        let maxError = 0, energy = 0;
        for (let sample = 0; sample < reference.length; sample++) {
          const frame = Math.floor(sample / 1600);
          const gain = 10 ** (6 / 20) * Math.min(1, frame / 30, (totalFrames - 1 - frame) / 30);
          maxError = Math.max(maxError, Math.abs(adjusted[sample]! - reference[sample]! * gain));
          energy += reference[sample]! ** 2;
        }
        expect(energy / reference.length).toBeGreaterThan(0.002);
        expect(maxError).toBeLessThan(1e-6);
        expect([...adjusted.slice(-1600)].every(value => value === 0)).toBe(true);
      });
    }
  }
  it('places both source channels at independently calculated sample positions after reorder, gap and overlap', () => {
    const fps = 29.97, totalFrames = 71, sourceSamples = 144_000;
    const bytes = Buffer.alloc(sourceSamples * 2 * 4);
    for (let index = 0; index < sourceSamples; index++) {
      bytes.writeFloatLE(((index * 17 % 997) / 997 - 0.5) * 0.1, index * 8);
      bytes.writeFloatLE(((index * 31 % 991) / 991 - 0.5) * 0.2, index * 8 + 4);
    }
    writeFileSync(join(directory, 'stereo.raw'), bytes);
    ffmpeg(['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', join(directory, 'stereo.raw'), '-c:a', 'pcm_f32le', join(directory, 'stereo.wav')]);
    const segments = [
      { originalStart: 42, originalEnd: 62, finalStart: 5, durationFrames: 20, playbackRate: 1 },
      { originalStart: 3, originalEnd: 26, finalStart: 20, durationFrames: 23, playbackRate: 1 },
      { originalStart: 65, originalEnd: 81, finalStart: 55, durationFrames: 16, playbackRate: 1 },
    ];
    const actual = render({ fps, totalFrames, hasAudio: true, settings: baseline, segments }, 'positions', 'stereo.wav', 2);
    const expected = new Float64Array(actual.length);
    for (const segment of segments) {
      const from = Math.round(segment.originalStart * 48000 / fps), to = Math.round(segment.originalEnd * 48000 / fps);
      const destination = Math.round(segment.finalStart * 48000 / fps);
      const length = Math.round((segment.finalStart + segment.durationFrames) * 48000 / fps) - destination;
      for (let offset = 0; offset < Math.min(length, to - from); offset++) {
        for (let channel = 0; channel < 2; channel++) {
          expected[(destination + offset) * 2 + channel]! += bytes.readFloatLE(((from + offset) * 2 + channel) * 4);
        }
      }
    }
    let maxError = 0;
    for (let index = 0; index < actual.length; index++) maxError = Math.max(maxError, Math.abs(actual[index]! - expected[index]!));
    expect(maxError).toBeLessThan(1e-7);
  });
  it('makes exact silence for muted or absent source audio without touching other stems', () => {
    for (const hasAudio of [true, false]) {
      const data = render({ fps: 29.97, totalFrames: 71, hasAudio,
        settings: { ...baseline, muted: hasAudio },
        segments: [{ originalStart: 0, originalEnd: 71, finalStart: 0, durationFrames: 71, playbackRate: 1 }] }, `silent-${hasAudio}`);
      expect(data.every(value => value === 0)).toBe(true);
    }
  });
  for (const fps of [29.97, 192000 / 1001]) {
    it(`changes fade gain at rounded sample boundaries at ${fps} fps`, () => {
      const totalFrames = 71;
      const input: MainAudioFilterInput = { fps, totalFrames, hasAudio: true, settings: baseline,
        segments: [{ originalStart: 0, originalEnd: totalFrames, finalStart: 0, durationFrames: totalFrames, playbackRate: 1 }] };
      const reference = render(input, `fractional-${fps}-unity`);
      const adjusted = render({ ...input, settings: { ...baseline, gainDb: 6, fadeInFrames: 30, fadeOutFrames: 30 } }, `fractional-${fps}-fade`);
      let frame = 0, maxError = 0;
      for (let sample = 0; sample < reference.length; sample++) {
        while (frame < totalFrames - 1 && sample >= Math.round((frame + 1) * 48000 / fps)) frame++;
        const gain = 10 ** (6 / 20) * Math.min(1, frame / 30, (totalFrames - 1 - frame) / 30);
        maxError = Math.max(maxError, Math.abs(adjusted[sample]! - reference[sample]! * gain));
      }
      expect(maxError).toBeLessThan(1e-6);
    });
  }
  it('rejects non-finite settings and segment positions before building a command', () => {
    const input: MainAudioFilterInput = { fps: 30, totalFrames: 90, hasAudio: true, settings: baseline,
      segments: [{ originalStart: 0, originalEnd: 90, finalStart: 0, durationFrames: 90, playbackRate: 1 }] };
    for (const fps of [0, NaN, Infinity, 1e-300]) expect(() => buildMainAudioFilter({ ...input, fps })).toThrow();
    for (const playbackRate of [0, NaN, Infinity, 20]) expect(() => buildMainAudioFilter({ ...input, segments: [{ ...input.segments[0]!, playbackRate }] })).toThrow();
    expect(() => buildMainAudioFilter({ ...input, settings: { ...baseline, gainDb: Infinity } })).toThrow();
    expect(() => buildMainAudioFilter({ ...input, segments: [{ ...input.segments[0]!, finalStart: 1 }] })).toThrow();
  });
});

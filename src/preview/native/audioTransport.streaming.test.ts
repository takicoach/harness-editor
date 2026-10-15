import { afterEach, expect, it, vi } from 'vitest';
import { ScenePlan } from '../../core/sequence/scenePlan';
import type { SequenceDocument } from '../../core/sequence/model';
import { rational as r } from '../../core/sequence/time';
import { pcmKey, type PcmRange, type WindowedPcm } from './audioMixer';
import { LOOK_AHEAD_SECONDS, NativeAudioTransport, PRIME_SECONDS } from './audioTransport';

afterEach(() => vi.useRealTimers());

// 10 秒（300 フレーム）の原音クリップ 1 本。PCM は窓読み（RemotePcm 相当）の偽物で、届いた sample までしか持たない。
const SAMPLES = 480_000;
function plan(): ScenePlan {
  const doc: SequenceDocument = { schemaVersion: 2, id: 'stream', name: '窓読み', revision: 0, fps: r(30), resolution: { width: 2, height: 2 }, sequenceEndFrame: 300, background: '#000000',
    assets: [{ id: 'a', kind: 'media', name: 'a', file: 'a.wav', fingerprint: 'a', streams: [{ index: 0, kind: 'audio', duration: r(10), codec: 'pcm', sampleRate: 48000, channels: 2 }] }],
    tracks: [{ id: 'audio', kind: 'audio', name: '原音', enabled: true }],
    clips: [{ id: 'c', trackId: 'audio', name: 'c', startFrame: 0, durationFrames: 300, clock: { offset: r(0), duration: r(10), rate: r(1) },
      content: { kind: 'audio', assetId: 'a', streamIndex: 0, sourceIn: r(0), rate: r(1), role: 'speech', loop: false, settings: { gainDb: 0, muted: false, fadeInFrames: 0, fadeOutFrames: 0 } } }],
    transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
  return new ScenePlan(doc);
}
class FakeStream implements WindowedPcm {
  sampleRate = 48000; sampleCount = SAMPLES; assetId = 'a'; streamIndex = 0; rate = r(1);
  delivered = 0; requested: PcmRange[] = []; probed: PcmRange[] = []; failure: Error | undefined;
  private waiters: Array<{ to: number; resolve: () => void }> = [];
  sample(): number { return .5; }
  has(ranges: readonly PcmRange[]): boolean { this.probed.push(...ranges); return ranges.every(range => range.to <= this.delivered); }
  ensure(ranges: readonly PcmRange[], signal?: AbortSignal): Promise<void> {
    this.requested.push(...ranges);
    if (this.failure) return Promise.reject(this.failure);
    const to = Math.max(...ranges.map(range => range.to));
    if (to <= this.delivered) return Promise.resolve();
    return new Promise((resolve, reject) => { this.waiters.push({ to, resolve }); signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  }
  deliver(upTo: number): void { this.delivered = Math.max(this.delivered, upTo); this.waiters = this.waiters.filter(w => { if (w.to <= this.delivered) { w.resolve(); return false; } return true; }); }
  get requestedEnd(): number { return Math.max(0, ...this.requested.map(range => range.to)); }
  get requestedStart(): number { return Math.min(SAMPLES, ...this.requested.map(range => range.from)); }
  get probedEnd(): number { return Math.max(0, ...this.probed.map(range => range.to)); }
}
/** 実機と同じく 25ms ごとに時計を進めて timer を起こす（時計だけ飛ばすと「追いつかない」の正当な失敗になる）。 */
function tick(ctx: ReturnType<typeof context>, seconds: number): void {
  const steps = Math.round(seconds / .025);
  for (let i = 0; i < steps; i++) { ctx.value.currentTime = Math.round((ctx.value.currentTime + .025) * 1000) / 1000; vi.advanceTimersByTime(25); }
}
function context() {
  const starts: number[] = [];
  const value = { currentTime: 10, sampleRate: 48000, destination: {}, resume: vi.fn(async () => {}),
    createBuffer: vi.fn((_channels: number, count: number) => ({ length: count, copyToChannel: vi.fn() })),
    createBufferSource: vi.fn(() => ({ buffer: null, onended: null, connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start: (at: number) => starts.push(at) })) };
  return { value, starts, audio: value as unknown as AudioContext };
}
function setup(rate = 1) {
  vi.useFakeTimers();
  const ctx = context(), fake = new FakeStream(), onError = vi.fn();
  const transport = new NativeAudioTransport(ctx.audio, plan(), new Map([[pcmKey('a', 0, r(rate)), fake]]), onError, rate);
  return { ctx, fake, onError, transport };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

it('prime waits for the initial window at the seek position, then starts the look-ahead', async () => {
  const { fake, transport } = setup();
  transport.seek(48000);
  let primed = false; const priming = transport.prime().then(() => { primed = true; });
  await settle();
  expect(primed).toBe(false);
  expect(fake.requestedStart).toBeLessThanOrEqual(48000);
  expect(fake.requestedEnd).toBeGreaterThanOrEqual(48000 + PRIME_SECONDS * 48000);
  expect(fake.requestedEnd).toBeLessThan(48000 + PRIME_SECONDS * 48000 + 8192);
  fake.deliver(48000 + PRIME_SECONDS * 48000 + 8192);
  await priming;
  expect(primed).toBe(true);
  // 先読みは初期窓の先（LOOK_AHEAD_SECONDS）まで要求する。
  expect(fake.requestedEnd).toBeGreaterThanOrEqual(48000 + LOOK_AHEAD_SECONDS * 48000);
  transport.dispose();
});

it('prime resolves at once when the window is already resident and rejects when its signal aborts', async () => {
  const { fake, transport } = setup();
  fake.deliver(SAMPLES);
  transport.seek(0); await transport.prime();
  const { fake: slow, transport: waiting } = setup();
  const controller = new AbortController();
  const pending = waiting.prime(controller.signal);
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  expect(slow.delivered).toBe(0);
  transport.dispose(); waiting.dispose();
});

it('a missing chunk pauses scheduling without an error and resumes from the live position once delivered', async () => {
  const { ctx, fake, onError, transport } = setup();
  fake.deliver(48000);
  transport.seek(0); await transport.play();
  expect(ctx.starts.length).toBeGreaterThan(0);
  // 0.9 秒進む: 先読み窓（+0.3 秒）が届いている範囲（1 秒）を越えて止まる。
  tick(ctx, .9);
  expect(onError).not.toHaveBeenCalled();
  const scheduled = ctx.starts.length;
  expect(Math.max(...ctx.starts)).toBeLessThan(10.05 + 1);
  // 届いている範囲を再生し切ってもエラーにしない（区画待ち）。
  tick(ctx, .6);
  expect(ctx.value.currentTime).toBe(11.5);
  expect(onError).not.toHaveBeenCalled();
  expect(ctx.starts.length).toBe(scheduled);
  expect(transport.isPlaying).toBe(true);
  // 届いたら、過ぎた分は飛ばして今の位置から続ける（過去の時刻には予約しない）。
  fake.deliver(SAMPLES); vi.advanceTimersByTime(25);
  expect(onError).not.toHaveBeenCalled();
  const resumed = ctx.starts.slice(scheduled);
  expect(resumed.length).toBeGreaterThan(0);
  for (const at of resumed) expect(at).toBeGreaterThanOrEqual(11.5);
  expect(transport.currentSample()).toBeGreaterThan(69_000);
  transport.dispose();
});

it('keeps requesting LOOK_AHEAD_SECONDS ahead of the play position during playback', async () => {
  const { ctx, fake, transport } = setup();
  fake.deliver(SAMPLES);
  transport.seek(0); await transport.play();
  expect(fake.probedEnd).toBeGreaterThanOrEqual(LOOK_AHEAD_SECONDS * 48000);
  tick(ctx, 2);
  expect(fake.probedEnd).toBeGreaterThanOrEqual(2 * 48000 + LOOK_AHEAD_SECONDS * 48000);
  transport.dispose();
});

it('still reports falling behind when every chunk is present', async () => {
  const { ctx, fake, onError, transport } = setup();
  fake.deliver(SAMPLES);
  transport.seek(0); await transport.play();
  ctx.value.currentTime = 11; vi.advanceTimersByTime(25);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('追いつきません') }));
  expect(transport.isPlaying).toBe(false);
  transport.dispose();
});

it('surfaces a failed look-ahead request as a playback error', async () => {
  const { ctx, fake, onError, transport } = setup();
  fake.deliver(48000);
  transport.seek(0); await transport.play();
  fake.failure = new Error('準備した音声を読み込めません');
  ctx.value.currentTime = 10.1; vi.advanceTimersByTime(25); await settle(); vi.advanceTimersByTime(25);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '準備した音声を読み込めません' }));
  expect(transport.isPlaying).toBe(false);
  transport.dispose();
});

it('whole-array sources keep the previous behaviour', async () => {
  vi.useFakeTimers();
  const ctx = context(), onError = vi.fn();
  const channels = [new Float32Array(SAMPLES), new Float32Array(SAMPLES)];
  const transport = new NativeAudioTransport(ctx.audio, plan(), new Map([[pcmKey('a', 0, r(1)), { assetId: 'a', streamIndex: 0, rate: r(1), sampleRate: 48000, channels }]]), onError);
  transport.seek(0); await transport.prime(); await transport.play();
  ctx.value.currentTime = 10.2; vi.advanceTimersByTime(25);
  expect(onError).not.toHaveBeenCalled();
  expect(ctx.starts.length).toBeGreaterThan(3);
  transport.dispose();
});

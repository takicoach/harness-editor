import type { ScenePlan } from '../../core/sequence/scenePlan';
import { mixAudioBlock, pcmReadRanges, sequenceSampleCount, type PcmRange, type PcmSource } from './audioMixer';
import { audioPlaybackPlan } from './audioPlaybackPlan';

/** 窓読みの PCM（RemotePcm）。揃っているかを `has` で確かめ、足りない区画を `ensure` で取り寄せる。 */
export interface StreamedPcm {
  has(ranges: readonly PcmRange[]): boolean;
  ensure(ranges: readonly PcmRange[], signal?: AbortSignal): Promise<void>;
}
const streamed = (source: PcmSource | undefined): source is PcmSource & StreamedPcm =>
  !!source && typeof (source as Partial<StreamedPcm>).has === 'function' && typeof (source as Partial<StreamedPcm>).ensure === 'function';

/** 再生位置の先、この秒数ぶん（出力時間）の区画を先に取り寄せる。 */
export const LOOK_AHEAD_SECONDS = 4;
/** 再生を始める前に揃えておく窓（出力時間）。これだけ揃えば鳴らし始め、残りは先読みが追いかける。 */
export const PRIME_SECONDS = 1;

/** The AudioContext clock drives both audible and silent timelines. */
export class NativeAudioTransport {
  private nodes = new Set<AudioBufferSourceNode>();
  private timer?: ReturnType<typeof setInterval>;
  private anchorSample = 0;
  private anchorTime = 0;
  private nextSample = 0;
  private playing = false;
  private epoch = 0;
  private disposed = false;
  /** 直前の schedule が区画待ちで止まった。次に届いたら、過ぎた分は無音のまま飛ばす。 */
  private stalled = false;
  private prefetchFailure: Error | undefined;
  private lastPresentationSample?: number;
  private readonly endSample: number;
  private readonly mixingPlan: ReturnType<typeof audioPlaybackPlan>;
  private readonly mixingEndSample: number;

  constructor(readonly context: AudioContext, plan: ScenePlan,
    private readonly sources: ReadonlyMap<string, PcmSource>, private readonly onError: (error: Error) => void,
    readonly playbackRate = 1) {
    this.endSample = sequenceSampleCount(plan, context.sampleRate);
    this.mixingPlan = audioPlaybackPlan(plan, playbackRate);
    this.mixingEndSample = sequenceSampleCount(this.mixingPlan, context.sampleRate);
  }
  get isPlaying(): boolean { return this.playing; }
  currentSample(): number {
    if (!this.playing) return this.anchorSample;
    const elapsed = Math.max(0, this.context.currentTime - this.anchorTime);
    return Math.max(0, Math.min(this.endSample, this.anchorSample + Math.floor(elapsed * this.context.sampleRate * this.playbackRate)));
  }
  /** Video-only position at the current RAF timestamp; PCM keeps currentSample(). */
  presentationSample(rafTimestamp: number): number {
    if (!this.playing) return this.currentSample();
    const sample = this.outputSample(rafTimestamp), previous = this.lastPresentationSample ?? this.anchorSample;
    // Raw fallback may run ahead of output. Recovery must not reverse video
    // within one play epoch; audio scheduling/paused position remain unchanged.
    this.lastPresentationSample = this.playbackRate > 0 ? Math.max(previous, sample) : Math.min(previous, sample);
    return this.lastPresentationSample;
  }
  private outputSample(rafTimestamp: number): number {
    if (!Number.isFinite(rafTimestamp) || rafTimestamp < 0) return this.currentSample();
    try {
      const {contextTime, performanceTime} = this.context.getOutputTimestamp?.() ?? {};
      // Bound extrapolation to a nearby timestamp pair. Zero is the browser's
      // not-yet-available value; 100ms is a fallback policy, not a latency offset.
      if (typeof contextTime !== 'number' || !Number.isFinite(contextTime) || contextTime <= 0 ||
          typeof performanceTime !== 'number' || !Number.isFinite(performanceTime) || performanceTime <= 0 ||
          Math.abs(rafTimestamp - performanceTime) > 100) return this.currentSample();
      const at = contextTime + (rafTimestamp - performanceTime) / 1000;
      const elapsed = Math.max(0, at - this.anchorTime);
      return Math.max(0, Math.min(this.endSample, this.anchorSample + Math.floor(elapsed * this.context.sampleRate * this.playbackRate)));
    } catch { return this.currentSample(); }
  }
  /** 出力 sample 位置 start から count ぶんの混合に要る、素材ごとの PCM 範囲。 */
  private needed(start: number, count: number): Map<string, PcmRange[]> {
    const length = Math.max(0, Math.min(count, this.mixingEndSample - start));
    return pcmReadRanges(this.mixingPlan, this.sources, start, length, this.context.sampleRate);
  }
  /** 窓読みの素材がその範囲を持っているか（持っていれば「最近使った」側へ寄せる）。配列で持つ素材は常に揃っている。 */
  private available(start: number, count: number): boolean {
    for (const [key, ranges] of this.needed(start, count)) {
      const source = this.sources.get(key);
      if (streamed(source) && !source.has(ranges)) return false;
    }
    return true;
  }
  /** 再生位置の先 LOOK_AHEAD_SECONDS ぶんを取り寄せる（待たない）。失敗は次の schedule で再生の失敗として表に出す。 */
  private prefetch(start: number): void {
    for (const [key, ranges] of this.needed(start, Math.ceil(LOOK_AHEAD_SECONDS * this.context.sampleRate))) {
      const source = this.sources.get(key);
      if (!streamed(source) || source.has(ranges)) continue;
      void source.ensure(ranges).catch(error => { if (!this.disposed) this.prefetchFailure ??= error instanceof Error ? error : new Error(String(error)); });
    }
  }
  /** 今の位置から PRIME_SECONDS ぶんの窓を揃える。揃ったら先読みを始める。逆再生は無音なので何も待たない。 */
  async prime(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.disposed || this.playbackRate < 0) return;
    const start = Math.min(this.mixingEndSample, Math.ceil(this.anchorSample / this.playbackRate));
    const waits: Promise<void>[] = [];
    for (const [key, ranges] of this.needed(start, Math.ceil(PRIME_SECONDS * this.context.sampleRate))) {
      const source = this.sources.get(key);
      if (streamed(source) && !source.has(ranges)) waits.push(source.ensure(ranges, signal));
    }
    if (waits.length) await Promise.all(waits);
    signal?.throwIfAborted();
    if (!this.disposed) this.prefetch(start);
  }
  async play(): Promise<void> {
    if (this.disposed || this.playing || (this.playbackRate > 0 ? this.anchorSample >= this.endSample : this.anchorSample <= 0)) return;
    const epoch = ++this.epoch;
    await this.context.resume();
    if (epoch !== this.epoch || this.disposed) return;
    this.lastPresentationSample = undefined;
    // 停止中に届いた古い先読みの失敗は次の再生に持ち越さない（問題が続いていれば prime / 先読みで改めて表に出る）。
    this.prefetchFailure = undefined;
    this.playing = true; this.anchorTime = this.context.currentTime + .05; this.stalled = false;
    // Never schedule PCM preceding a seek; the sub-sample remainder becomes at
    // most one output sample of silence, not audio from the previous position.
    this.nextSample = Math.ceil(this.anchorSample / Math.abs(this.playbackRate));
    try {
      this.schedule();
      this.timer = setInterval(() => {
        try {
          if (this.playbackRate > 0 ? this.currentSample() >= this.endSample : this.currentSample() <= 0) { this.pause(); return; }
          this.schedule();
        } catch (error) { this.pause(); this.onError(error instanceof Error ? error : new Error(String(error))); }
      }, 25);
    } catch (error) { this.pause(); throw error; }
  }
  pause(): void {
    ++this.epoch;
    this.lastPresentationSample = undefined;
    this.anchorSample = this.currentSample(); this.playing = false; this.stalled = false;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const node of this.nodes) { node.onended = null; node.stop(); node.disconnect(); }
    this.nodes.clear();
  }
  seek(sample: number): void {
    if (!Number.isSafeInteger(sample) || sample < 0 || sample > this.endSample) throw new Error('音声のシーク先が不正です');
    this.pause(); this.anchorSample = sample;
  }
  private schedule(): void {
    if (this.playbackRate < 0) return;
    if (this.prefetchFailure) { const failure = this.prefetchFailure; this.prefetchFailure = undefined; throw failure; }
    const rate = this.context.sampleRate, now = this.context.currentTime, lookAhead = now + .3;
    if (this.stalled) {
      // 区画待ちの間も時計は進む。過ぎた分は無音のまま飛ばし、少し先から続ける（過去の時刻に予約しない）。
      const live = Math.ceil((now + .02 - this.anchorTime) * rate + this.anchorSample / this.playbackRate);
      if (this.nextSample < live) this.nextSample = live;
      this.stalled = false;
    }
    this.prefetch(this.nextSample);
    while (this.nextSample < this.mixingEndSample) {
      const at = this.anchorTime + (this.nextSample - this.anchorSample / this.playbackRate) / rate;
      if (at > lookAhead) break;
      const count = Math.min(4096, this.mixingEndSample - this.nextSample);
      if (!this.available(this.nextSample, count)) { this.stalled = true; break; }
      if (at < now - .005) throw new Error('音声の準備が再生に追いつきません。再生を停止しました');
      const pcm = mixAudioBlock(this.mixingPlan, this.sources, this.nextSample, count, rate);
      const buffer = this.context.createBuffer(2, count, rate);
      buffer.copyToChannel(pcm[0], 0); buffer.copyToChannel(pcm[1], 1);
      const node = this.context.createBufferSource(); node.buffer = buffer; node.connect(this.context.destination);
      node.onended = () => { node.disconnect(); this.nodes.delete(node); };
      this.nodes.add(node); node.start(at); this.nextSample += count;
    }
  }
  dispose(): void { this.pause(); this.disposed = true; }
}

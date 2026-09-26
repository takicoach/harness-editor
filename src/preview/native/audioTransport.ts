import type { ScenePlan } from '../../core/sequence/scenePlan';
import { mixAudioBlock, sequenceSampleCount, type PreparedPcm } from './audioMixer';
import { audioPlaybackPlan } from './audioPlaybackPlan';

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
  private lastPresentationSample?: number;
  private readonly endSample: number;
  private readonly mixingPlan: ReturnType<typeof audioPlaybackPlan>;
  private readonly mixingEndSample: number;

  constructor(readonly context: AudioContext, plan: ScenePlan,
    private readonly sources: ReadonlyMap<string, PreparedPcm>, private readonly onError: (error: Error) => void,
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
  async play(): Promise<void> {
    if (this.disposed || this.playing || (this.playbackRate > 0 ? this.anchorSample >= this.endSample : this.anchorSample <= 0)) return;
    const epoch = ++this.epoch;
    await this.context.resume();
    if (epoch !== this.epoch || this.disposed) return;
    this.lastPresentationSample = undefined;
    this.playing = true; this.anchorTime = this.context.currentTime + .05;
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
    this.anchorSample = this.currentSample(); this.playing = false;
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
    const rate = this.context.sampleRate, lookAhead = this.context.currentTime + .3;
    while (this.nextSample < this.mixingEndSample) {
      const at = this.anchorTime + (this.nextSample - this.anchorSample / this.playbackRate) / rate;
      if (at > lookAhead) break;
      if (at < this.context.currentTime - .005) throw new Error('音声の準備が再生に追いつきません。再生を停止しました');
      const count = Math.min(4096, this.mixingEndSample - this.nextSample);
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

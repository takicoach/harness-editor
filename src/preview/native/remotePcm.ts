import type { Rational } from '../../core/sequence/time';
import type { PcmRange, WindowedPcm } from './audioMixer';
import { PreviewResourceError } from './previewError';

/**
 * 再生用 PCM を丸ごと持たずに、必要な区画だけを HTTP Range で取り寄せる WindowedPcm。
 *
 * サーバの `/audio/data`（serveAsset）は f32le・48kHz・2ch interleaved を Range（206）で返す。
 * 区画は 65,536 sample（約 1.37 秒・512 KiB）。混合側（audioMixer）は `has()` で揃っていることを
 * 確かめてから `sample()` を読む契約で、揃っていない区画を読むと例外になる（黙って無音にしない）。
 * 保持は区画数で上限を持ち、最近使っていない区画から退避する。今まさに要求している区画は退避しない。
 */
export const REMOTE_PCM_CHUNK_SAMPLES = 65_536;
/** 既定の保持上限（区画数）。64 区画 ＝ 約 32 MiB ＝ 約 87 秒ぶん。素材（速度）ごとに持つ。 */
export const REMOTE_PCM_RESIDENT_CHUNKS = 64;
/** 1 回の Range で結合する区画数の上限。8 区画 ＝ 4 MiB。 */
export const REMOTE_PCM_MAX_CHUNKS_PER_REQUEST = 8;
const BYTES_PER_SAMPLE = 8; // 2ch × float32

export interface RemotePcmOptions {
  url: string;
  sampleCount: number;
  sampleRate: number;
  assetId: string;
  streamIndex: number;
  rate: Rational;
  /** 旧エディタの貸与（legacy-preview）の URL か。404 を「貸与の失効」として分類するため。省略時は URL から判断する。 */
  legacy?: boolean;
  /** 試験用の差し替え。既定は globalThis.fetch。 */
  fetch?: typeof fetch;
  chunkSamples?: number;
  residentChunks?: number;
  maxChunksPerRequest?: number;
}

/** 半開区間の集まりが触れる区画番号を昇順・重複なしで返す。末尾（sampleCount）を越える部分は切り捨てる。 */
export function remotePcmChunkIndexes(ranges: readonly PcmRange[], chunkSamples: number, sampleCount: number): number[] {
  const chunks = new Set<number>();
  for (const range of ranges) {
    const from = Math.max(0, Math.floor(range.from)), to = Math.min(sampleCount, Math.ceil(range.to));
    if (from >= to) continue;
    for (let chunk = Math.floor(from / chunkSamples), last = Math.floor((to - 1) / chunkSamples); chunk <= last; chunk++) chunks.add(chunk);
  }
  return [...chunks].sort((a, b) => a - b);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('中止しました', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('中止しました', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export class RemotePcm implements WindowedPcm {
  readonly sampleRate: number;
  readonly sampleCount: number;
  readonly assetId: string;
  readonly streamIndex: number;
  readonly rate: Rational;
  private readonly url: string;
  private readonly legacy: boolean;
  private readonly fetcher: typeof fetch;
  private readonly chunkSamples: number;
  private readonly residentChunks: number;
  private readonly maxChunksPerRequest: number;
  /** 区画番号 → interleaved サンプル。挿入順が「最近使った順」（touch で入れ直す）。 */
  private readonly chunks = new Map<number, Float32Array>();
  private readonly loading = new Map<number, Promise<void>>();
  private readonly pins = new Map<number, number>();
  private readonly controller = new AbortController();
  private bytes = 0;
  private lastChunk = -1;
  private lastData: Float32Array | undefined;

  constructor(options: RemotePcmOptions) {
    const { sampleCount, sampleRate, chunkSamples = REMOTE_PCM_CHUNK_SAMPLES, residentChunks = REMOTE_PCM_RESIDENT_CHUNKS, maxChunksPerRequest = REMOTE_PCM_MAX_CHUNKS_PER_REQUEST } = options;
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0 || !Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new Error('音声PCMの形式が不正です');
    if (!Number.isSafeInteger(chunkSamples) || chunkSamples <= 0 || !Number.isSafeInteger(residentChunks) || residentChunks <= 0 || !Number.isSafeInteger(maxChunksPerRequest) || maxChunksPerRequest <= 0) throw new Error('音声PCMの区画設定が不正です');
    this.url = options.url; this.sampleCount = sampleCount; this.sampleRate = sampleRate;
    this.legacy = options.legacy ?? new URL(options.url, 'http://preview.local').pathname.startsWith('/api/legacy-preview/');
    this.assetId = options.assetId; this.streamIndex = options.streamIndex; this.rate = options.rate;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.chunkSamples = chunkSamples; this.residentChunks = residentChunks; this.maxChunksPerRequest = maxChunksPerRequest;
  }

  /** 今メモリに持っている PCM のバイト数。 */
  get residentBytes(): number { return this.bytes; }

  sample(channel: number, index: number): number {
    const chunk = Math.floor(index / this.chunkSamples);
    let data = chunk === this.lastChunk ? this.lastData : undefined;
    if (!data) {
      data = this.chunks.get(chunk);
      if (!data || index < 0) throw new Error(`音声の読込範囲が不足しています: ${this.assetId} / ${index}`);
      this.lastChunk = chunk; this.lastData = data;
    }
    const offset = (index - chunk * this.chunkSamples) * 2 + channel;
    if (offset >= data.length) throw new Error(`音声の読込範囲が不足しています: ${this.assetId} / ${index}`);
    return data[offset]!;
  }

  /** 範囲の区画がすべて揃っているか。揃っていれば「最近使った」側へ寄せる。 */
  has(ranges: readonly PcmRange[]): boolean {
    const needed = remotePcmChunkIndexes(ranges, this.chunkSamples, this.sampleCount);
    for (const chunk of needed) if (!this.chunks.has(chunk)) return false;
    for (const chunk of needed) this.touch(chunk);
    return true;
  }

  /** 足りない区画を取り寄せる。連続する区画は 1 回の Range にまとめ、取得中の区画には合流する。 */
  async ensure(ranges: readonly PcmRange[], signal?: AbortSignal): Promise<void> {
    if (this.controller.signal.aborted) throw new DOMException('音声の読み込みは終了しています', 'AbortError');
    signal?.throwIfAborted();
    const needed = remotePcmChunkIndexes(ranges, this.chunkSamples, this.sampleCount);
    for (const chunk of needed) this.pins.set(chunk, (this.pins.get(chunk) ?? 0) + 1);
    try {
      const pending: Promise<void>[] = [];
      let run: number[] = [];
      const flush = () => {
        if (!run.length) return;
        const chunks = run; run = [];
        const promise: Promise<void> = this.request(chunks).finally(() => { for (const chunk of chunks) if (this.loading.get(chunk) === promise) this.loading.delete(chunk); });
        for (const chunk of chunks) this.loading.set(chunk, promise);
        pending.push(promise);
      };
      for (const chunk of needed) {
        if (this.chunks.has(chunk)) { this.touch(chunk); continue; }
        const inflight = this.loading.get(chunk);
        if (inflight) { flush(); pending.push(inflight); continue; }
        if (run.length && (chunk !== run[run.length - 1]! + 1 || run.length >= this.maxChunksPerRequest)) flush();
        run.push(chunk);
      }
      flush();
      if (pending.length) await abortable(Promise.all(pending), signal);
      for (const chunk of needed) this.touch(chunk);
    } finally {
      for (const chunk of needed) { const count = (this.pins.get(chunk) ?? 1) - 1; if (count > 0) this.pins.set(chunk, count); else this.pins.delete(chunk); }
    }
  }

  /** 取得中の要求を中止する。以後の ensure は断る。保持している区画は捨てる。 */
  dispose(): void {
    this.controller.abort();
    this.chunks.clear(); this.bytes = 0; this.lastChunk = -1; this.lastData = undefined;
  }

  private touch(chunk: number): void {
    const data = this.chunks.get(chunk);
    if (data) { this.chunks.delete(chunk); this.chunks.set(chunk, data); }
  }

  private async request(chunks: number[]): Promise<void> {
    const first = chunks[0]!, last = chunks[chunks.length - 1]!;
    const start = first * this.chunkSamples * BYTES_PER_SAMPLE, end = Math.min((last + 1) * this.chunkSamples, this.sampleCount) * BYTES_PER_SAMPLE;
    const response = await this.fetcher(this.url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: this.controller.signal });
    if (response.status !== 206) { await response.body?.cancel().catch(() => undefined); throw new PreviewResourceError('準備した音声を読み込めません', response.status, 'pcm', this.legacy); }
    if (response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${this.sampleCount * BYTES_PER_SAMPLE}`) {
      await response.body?.cancel().catch(() => undefined); throw new Error('準備した音声の長さが一致しません');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== end - start) throw new Error('準備した音声の長さが一致しません');
    if (this.controller.signal.aborted) return;
    for (const chunk of chunks) {
      const offset = (chunk - first) * this.chunkSamples * BYTES_PER_SAMPLE;
      const samples = Math.min((chunk + 1) * this.chunkSamples, this.sampleCount) - chunk * this.chunkSamples;
      this.store(chunk, new Float32Array(buffer.slice(offset, offset + samples * BYTES_PER_SAMPLE)));
    }
  }

  private store(chunk: number, data: Float32Array): void {
    const previous = this.chunks.get(chunk);
    if (previous) { this.bytes -= previous.byteLength; this.chunks.delete(chunk); }
    this.chunks.set(chunk, data); this.bytes += data.byteLength;
    if (this.lastChunk === chunk) { this.lastChunk = -1; this.lastData = undefined; }
    this.evict();
  }

  /** 上限を越えたら、要求中でない最も古い区画から捨てる。全部が要求中なら上限を越えたまま保つ。 */
  private evict(): void {
    if (this.chunks.size <= this.residentChunks) return;
    for (const [chunk, data] of this.chunks) {
      if (this.pins.has(chunk)) continue;
      this.chunks.delete(chunk); this.bytes -= data.byteLength;
      if (this.lastChunk === chunk) { this.lastChunk = -1; this.lastData = undefined; }
      if (this.chunks.size <= this.residentChunks) return;
    }
  }
}

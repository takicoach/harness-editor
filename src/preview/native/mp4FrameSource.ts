import { createFile, DataStream, type MP4BoxBuffer, type Movie, type Sample } from 'mp4box';
import { addTime, compareTime, rational, subtractTime, type Rational } from '../../core/sequence/time';
import {videoOnlyMp4Bytes} from './videoOnlyMp4Bytes';
import { sampleInVideoSourceWindow, type VideoSourceWindow } from './videoSourceWindow';
import { previewResourceError } from './previewError';
import {mp4Presentation} from './mp4Presentation';

export interface ByteSource {
  size: number;
  /** Which file the preview endpoint served (x-harness-preview-source). Unknown for exports and old servers. */
  origin?: 'original' | 'proxy';
  /** Half-open byte range. Return exactly end-start bytes; cancel I/O when signalled. */
  read(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer>;
}
export interface FrameIdentity {
  sample: number;
  pts: Rational;
  duration: Rational;
}
export interface AcquiredFrame { frame: VideoFrame; identity: FrameIdentity }

/** Range reads avoid retaining an entire original movie in the browser. */
export async function httpByteSource(url: string, signal?: AbortSignal): Promise<ByteSource> {
  const first = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
  const match = /^bytes 0-0\/(\d+)$/.exec(first.headers.get('content-range') ?? '');
  if (first.status !== 206 || !match) { await first.body?.cancel(); throw previewResourceError('映像の部分読み込みに対応した配信が必要です', first.status, 'asset', url); }
  const size = Number(match[1]);
  if (!Number.isSafeInteger(size) || size <= 0) { await first.body?.cancel(); throw new Error('映像ファイルのサイズが不正です'); }
  await first.arrayBuffer();
  const served = first.headers.get('x-harness-preview-source');
  const origin = served === 'original' || served === 'proxy' ? served : undefined;
  return { size, ...(origin ? { origin } : {}), async read(start, end, requestSignal) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > size) throw new Error('映像の読み込み範囲が不正です');
    const controller = new AbortController(), cancel = () => controller.abort();
    const upstream = [signal, requestSignal].filter((value): value is AbortSignal => value !== undefined);
    for (const value of upstream) { value.addEventListener('abort', cancel, { once: true }); if (value.aborted) cancel(); }
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: controller.signal });
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${size}`) {
        await response.body?.cancel(); throw previewResourceError('映像の読み込み範囲が一致しません', response.status, 'asset', url);
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== end - start) throw new Error('映像データが途中で切れています');
      return bytes;
    } finally {
      for (const value of upstream) value.removeEventListener('abort', cancel);
    }
  } };
}

interface IndexedSample { sample: Sample; identity: FrameIdentity; timestamp: number }
interface CompressedGroup { firstByte: number; encoded: ArrayBuffer }
interface PrefetchedGroup {
  start: number; end: number; request: AbortController; work: Promise<CompressedGroup>;
}
interface DecodeSession {
  start: number; groupStart: number; end: number; next: number; firstByte: number; encoded: ArrayBuffer;
  decoder: VideoDecoder; completed: boolean; failure?: Error;
  byTimestamp: Map<number, number>;
  outputSamples: Set<number>; listeners: Set<() => void>;
  prefetch?: PrefetchedGroup;
}
const COMPRESSED_BYTE_BUDGET = 64 * 1024 * 1024;
export const DECODE_PROGRESS_TIMEOUT_MS = 10_000;
export const DECODE_IDLE_TIMEOUT_MS = 1_000;
type DecodeStage = 'read' | 'decode' | 'flush';
const STAGE_LABEL: Record<DecodeStage, string> = { read: '映像の読み込み', decode: '映像の復号', flush: '映像の復号の完了待ち' };
const ORIGIN_LABEL: Record<NonNullable<ByteSource['origin']>, string> = { original: '元の動画', proxy: '軽量版' };
/** Name the stalled stage and served file so a report alone separates slow I/O from a stuck decoder. */
function decodeTimeoutError(stage: DecodeStage, origin: ByteSource['origin']): Error {
  return new Error(`${STAGE_LABEL[stage]}がタイムアウトしました${origin ? `（${ORIGIN_LABEL[origin]}）` : ''}。再試行してください`);
}

/** Shared random-access decoder. Every returned VideoFrame is owned by the caller. */
export class Mp4FrameSource {
  private cache = new Map<number, VideoFrame>();
  private cacheBytes = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private session?: DecodeSession;
  private retentionTarget = 0;
  private pending = new Set<(error: Error) => void>();
  private idleTimer?: ReturnType<typeof setTimeout>;

  private constructor(
    private readonly bytes: ByteSource,
    readonly config: VideoDecoderConfig,
    private readonly samples: IndexedSample[],
    private readonly cacheBudget: number,
    private readonly presentation: readonly {identity: FrameIdentity}[] = samples,
  ) {}

  static async open(bytes: ByteSource, videoTrackIndex = 0, cacheBudget = 64 * 1024 * 1024): Promise<Mp4FrameSource> {
    if (typeof VideoDecoder === 'undefined') throw new Error('このブラウザではWebCodecsの動画再生に対応していません');
    bytes=await videoOnlyMp4Bytes(bytes);
    const file = createFile(false);
    let movie: Movie | undefined, error: string | undefined, offset = 0, metadataBytes = 0;
    file.onReady = info => { movie = info; };
    file.onError = (...args) => { error = args.map(String).join(': '); };
    while (!movie && !error && offset < bytes.size) {
      const end = Math.min(bytes.size, offset + 256 * 1024);
      const buffer = await bytes.read(offset, end) as MP4BoxBuffer;
      buffer.fileStart = offset;
      metadataBytes += buffer.byteLength;
      if (metadataBytes > 32 * 1024 * 1024) throw new Error('映像の索引が大きすぎます。編集用プロキシを作成してください');
      const next = file.appendBuffer(buffer, end === bytes.size);
      offset = Math.max(end, next);
    }
    if (error || !movie) throw new Error(`MP4の索引を読み取れません: ${error ?? 'moovがありません'}`);
    const info = movie as Movie;
    if (info.isFragmented) throw new Error('分割MP4は編集用プロキシへ変換してください');
    const track = info.videoTracks[videoTrackIndex];
    if (!track?.video) throw new Error('映像トラックが見つかりません');
    const entries = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries;
    if (entries.length !== 1) throw new Error('複数の符号化形式がある映像はプロキシへ変換してください');
    const entry = entries[0] as unknown as Record<string, unknown>;
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    let description: ArrayBuffer | undefined;
    if (box && typeof box === 'object' && 'write' in box && typeof box.write === 'function') {
      const stream = new DataStream(); box.write(stream);
      description = stream.buffer.slice(8, stream.getPosition());
    }
    const config: VideoDecoderConfig = {
      codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
      codedWidth: track.video.width, codedHeight: track.video.height,
      ...(description ? { description } : {}), hardwareAcceleration: 'no-preference', optimizeForLatency: true,
    };
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`この映像形式には編集用プロキシが必要です: ${config.codec}`);
    let mediaStart = rational(0), leading = rational(0), editDuration: Rational | undefined;
    if (track.edits?.length) {
      let active = false;
      for (const edit of track.edits) {
        if (edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0) throw new Error('速度付きMP4編集リストはプロキシへ変換してください');
        if (edit.media_time === -1 && !active) leading = addTime(leading, rational(edit.segment_duration, track.movie_timescale));
        else if (!active && edit.media_time >= 0) {
          mediaStart = rational(edit.media_time, track.timescale);
          editDuration = rational(edit.segment_duration, track.movie_timescale); active = true;
        }
        else throw new Error('複雑なMP4編集リストはプロキシへ変換してください');
      }
      if (!active) throw new Error('表示区間のないMP4編集リストはプロキシへ変換してください');
    }
    const samples = file.getTrackSamplesInfo(track.id).map((sample, index) => {
      if (![sample.cts, sample.duration, sample.offset, sample.size, sample.timescale].every(Number.isSafeInteger)
        || sample.duration <= 0 || sample.timescale <= 0 || sample.offset < 0 || sample.size <= 0 || sample.offset + sample.size > bytes.size) {
        throw new Error('映像フレームの索引が不正です');
      }
      return { sample, timestamp: Math.round(sample.cts / sample.timescale * 1e6),
        identity: { sample: index, pts: addTime(subtractTime(rational(sample.cts, sample.timescale), mediaStart), leading), duration: rational(sample.duration, sample.timescale) } };
    });
    if (!samples.length || new Set(samples.map(s => s.timestamp)).size !== samples.length) throw new Error('映像フレームの時刻を一意に識別できません');
    const presentation=mp4Presentation(samples.map(s=>s.identity),leading,editDuration).map(identity=>({identity}));
    if (!presentation.length) throw new Error('映像の表示区間がありません');
    return new Mp4FrameSource(bytes, config, samples, cacheBudget, presentation);
  }

  get frameCount(): number { return this.samples.length; }
  /** Display intervals exclude edit preroll; frameCount still counts raw codec samples. */
  get identities(): FrameIdentity[] { return this.presentation.map(s => structuredClone(s.identity)); }

  acquire(time: Rational, holdLastFrame = false, sourceWindow?: VideoSourceWindow): Promise<AcquiredFrame> {
    // Copy the queued request so later caller mutations cannot change its bounds.
    const requestedTime = structuredClone(time), window = sourceWindow === undefined ? undefined : structuredClone(sourceWindow);
    const task = this.queue.then(() => this.acquireSerial(requestedTime, holdLastFrame, window));
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async acquireSerial(time: Rational, holdLastFrame: boolean, sourceWindow?: VideoSourceWindow): Promise<AcquiredFrame> {
    this.clearIdleTimer();
    try {
    if (this.disposed) throw new Error('映像は閉じられています');
    let target = sourceWindow !== undefined ? sampleInVideoSourceWindow(this.presentation, time, sourceWindow, holdLastFrame)
      : this.presentation.find(s => compareTime(s.identity.pts, time) <= 0
      && compareTime(time, addTime(s.identity.pts, s.identity.duration)) < 0)?.identity.sample ?? -1;
    if (target < 0 && sourceWindow === undefined && compareTime(time, rational(0)) >= 0) {
      // Some valid MP4s begin a fraction of one frame after zero (for example
      // 0.016s at 60fps). Show that first frame at zero instead of failing the
      // preview and the entire export. Keep intentional longer leading gaps.
      const first = this.presentation.reduce((a, b) => compareTime(a.identity.pts, b.identity.pts) <= 0 ? a : b).identity;
      if (compareTime(first.pts, rational(0)) > 0
        && compareTime(first.pts, first.duration) <= 0
        && compareTime(time, first.pts) < 0) target = first.sample;
    }
    if (target < 0 && holdLastFrame && sourceWindow === undefined) {
      const last = this.presentation.reduce((a, b) => compareTime(a.identity.pts, b.identity.pts) > 0 ? a : b);
      if (compareTime(time, addTime(last.identity.pts, last.identity.duration)) >= 0) target = last.identity.sample;
    }
    if (target < 0) throw new Error('指定時刻に映像フレームがありません');
    this.retentionTarget = target;
    if (this.session?.failure) { const error = this.session.failure; this.closeSession(error); throw error; }
    if (!this.cache.has(target)) await this.decodeGroup(target);
    const frame = this.cache.get(target);
    if (!frame || this.disposed) throw new Error('指定した映像フレームを復号できません');
    return { frame: frame.clone(), identity: structuredClone(this.presentation.find(s=>s.identity.sample===target)!.identity) };
    } finally {
      const session = this.session;
      if (session && !this.disposed) this.idleTimer = setTimeout(() => {
        if (this.session === session) this.closeSession();
      }, DECODE_IDLE_TIMEOUT_MS);
    }
  }
  private async decodeGroup(target: number): Promise<void> {
    let start = target, end = target + 1;
    while (start > 0 && !this.samples[start]!.sample.is_sync) start--;
    if (!this.samples[start]!.sample.is_sync) throw new Error('映像のキーフレームがありません');
    while (end < this.samples.length && !this.samples[end]!.sample.is_sync) end++;
    try {
      // An evicted frame that this session already produced requires a new
      // random-access decode. Otherwise keep the exact compressed cursor.
      const active = this.session;
      const inRange = active && start >= active.start && start < active.end;
      const nextGroup = active && start === active.end && active.next === active.end;
      if (!active || (!inRange && !nextGroup) || active.completed || active.outputSamples.has(target)) {
        this.closeSession();
        this.session = await this.openSession(start, end);
      }
      const session = this.session!;
      let advancedGroups = 0;
      while (!this.cache.has(target)) {
        this.assertSession(session);
        if (session.next === session.end) {
          // Continue the codec's presentation reorder buffer across keyframes.
          // At most one extra GOP per request: a codec withholding all output
          // must reach flush instead of reading the entire movie.
          if (session.end < this.samples.length && advancedGroups === 0 && session.outputSamples.size > 0) {
            try {
              if (await this.advanceSession(session, target)) advancedGroups++;
              continue;
            } catch (error) {
              // The target may already be in the decoder's reorder buffer.
              // A failed optional read must not invalidate that frame. Actual
              // next-group requests, decoder errors and disposal still fail.
              if (target >= session.end) throw error;
              this.assertSession(session);
            }
          }
          await this.awaitWork(session.decoder.flush(), 'flush');
          this.assertSession(session); session.completed = true;
          if (!this.cache.has(target)) throw new Error('指定した映像フレームを復号できません');
          break;
        }
        const indexed = this.samples[session.next++]!, { sample } = indexed;
        session.decoder.decode(new EncodedVideoChunk({ type: sample.is_sync ? 'key' : 'delta', timestamp: indexed.timestamp,
          duration: Math.round(sample.duration / sample.timescale * 1e6), data: new Uint8Array(session.encoded, sample.offset - session.firstByte, sample.size) }));
        await this.waitForDecoder(session, target);
      }
      this.assertSession(session);
      if (session.completed) this.closeSession();
    } catch (error) { this.closeSession(error instanceof Error ? error : new Error(String(error))); throw error; }
  }
  private async openSession(start: number, end: number): Promise<DecodeSession> {
    const data = await this.readGroup(start, end);
    if (!data) throw new Error('映像の読み込みが取り消されました');
    const { firstByte, encoded } = data;
    if (this.disposed) throw new Error('映像は閉じられています');
    const group = this.samples.slice(start, end);
    const session: DecodeSession = { start, groupStart: start, end, next: start, firstByte, encoded,
      decoder: undefined as unknown as VideoDecoder, byTimestamp: new Map(group.map(s => [s.timestamp, s.identity.sample])),
      completed: false, outputSamples: new Set(), listeners: new Set() };
    session.decoder = new VideoDecoder({
      output: frame => {
        const index = session.byTimestamp.get(frame.timestamp);
        if (this.disposed || this.session !== session || index === undefined) { frame.close(); return; }
        session.outputSamples.add(index); this.retainFrame(index, frame);
        for (const notify of session.listeners) notify();
      },
      error: error => { session.failure = error; for (const notify of session.listeners) notify(); },
    });
    session.decoder.addEventListener('dequeue', () => { for (const notify of session.listeners) notify(); });
    this.session = session;
    session.decoder.configure(this.config);
    this.prefetchNextGroup(session);
    return session;
  }
  private prefetchNextGroup(session: DecodeSession): void {
    if (this.disposed || this.session !== session || session.prefetch || session.end >= this.samples.length) return;
    const start = session.end;
    let end = start + 1;
    while (end < this.samples.length && !this.samples[end]!.sample.is_sync) end++;
    const { firstByte, lastByte } = this.groupRange(start, end);
    // Reserve the entire next range while the current compressed GOP is live.
    // Decoded-frame ownership/cache limits are separate and remain unchanged.
    if (session.encoded.byteLength + lastByte - firstByte > COMPRESSED_BYTE_BUDGET) return;
    const request = new AbortController();
    const work = Promise.resolve().then(() => {
      this.assertSession(session);
      if (request.signal.aborted) throw new Error('映像の先読みを取り消しました');
      return this.bytes.read(firstByte, lastByte, request.signal);
    }).then(encoded => {
      this.assertSession(session);
      if (request.signal.aborted) throw new Error('映像の先読みを取り消しました');
      return { firstByte, encoded };
    });
    session.prefetch = { start, end, request, work };
    // A speculative failure is not a playback failure until this GOP is needed.
    // Keep the original rejection for the ordinary required-read/flush path.
    void work.catch(() => undefined);
  }
  private async advanceSession(session: DecodeSession, target: number): Promise<boolean> {
    const start = session.end;
    let end = start + 1;
    while (end < this.samples.length && !this.samples[end]!.sample.is_sync) end++;
    // All compressed chunks of the old group have been submitted. Release its
    // byte storage before receiving another potentially 64 MiB group.
    session.encoded = new ArrayBuffer(0);
    let notify!: () => void;
    const available = new Promise<void>((resolve, reject) => {
      notify = () => {
        try { this.assertSession(session); if (this.cache.has(target)) resolve(); }
        catch (error) { reject(error); }
      };
      session.listeners.add(notify); notify();
    });
    try {
      const prefetched = session.prefetch;
      session.prefetch = undefined;
      const matching = prefetched?.start === start && prefetched.end === end ? prefetched : undefined;
      if (!matching) prefetched?.request.abort();
      const data = await this.readGroup(start, end, available, matching);
      this.assertSession(session);
      if (!data) return false;
      session.start = session.groupStart; session.groupStart = start;
      session.end = end; session.firstByte = data.firstByte; session.encoded = data.encoded;
      for (const [timestamp, index] of session.byTimestamp) if (index < session.start) session.byTimestamp.delete(timestamp);
      for (const index of session.outputSamples) if (index < session.start) session.outputSamples.delete(index);
      for (let index = start; index < end; index++) session.byTimestamp.set(this.samples[index]!.timestamp, index);
      this.prefetchNextGroup(session);
      return true;
    } finally { session.listeners.delete(notify); }
  }
  private groupRange(start: number, end: number): { firstByte: number; lastByte: number } {
    const group = this.samples.slice(start, end);
    const firstByte = Math.min(...group.map(s => s.sample.offset));
    const lastByte = Math.max(...group.map(s => s.sample.offset + s.sample.size));
    return { firstByte, lastByte };
  }
  private async readGroup(start: number, end: number, available?: Promise<void>, prefetched?: PrefetchedGroup): Promise<CompressedGroup | undefined> {
    const { firstByte, lastByte } = this.groupRange(start, end);
    if (lastByte - firstByte > COMPRESSED_BYTE_BUDGET) throw new Error('映像のキーフレーム間隔が大きすぎます。プロキシを作成してください');
    const request = prefetched?.request ?? new AbortController();
    try {
      const read = prefetched?.work ?? this.bytes.read(firstByte, lastByte, request.signal).then(encoded => ({ firstByte, encoded }));
      return await this.awaitWork(available ? Promise.race([read, available.then(() => undefined)]) : read, 'read');
    }
    finally { request.abort(); }
  }
  private retainFrame(index: number, frame: VideoFrame): void {
    const old = this.cache.get(index);
    if (old) { this.cacheBytes -= old.codedWidth * old.codedHeight * 4; old.close(); }
    this.cache.set(index, frame); this.cacheBytes += frame.codedWidth * frame.codedHeight * 4;
    while (this.cacheBytes > this.cacheBudget && this.cache.size > 1) {
      const target = this.retentionTarget, targetTime = this.samples[target]!.timestamp;
      const candidates = [...this.cache.keys()].filter(id => id !== target);
      // Use presentation time, including reordered B-frames. The anchor follows
      // the current request while delayed outputs from the live decoder arrive.
      const farthest = candidates.sort((a, b) => {
        const aTime = this.samples[a]!.timestamp, bTime = this.samples[b]!.timestamp;
        const aPast = aTime < targetTime, bPast = bTime < targetTime;
        if (aPast !== bPast) return aPast ? -1 : 1;
        return aPast ? aTime - bTime : bTime - aTime;
      })[0];
      if (farthest === undefined) break;
      const remove = this.cache.get(farthest)!;
      this.cacheBytes -= remove.codedWidth * remove.codedHeight * 4;
      remove.close(); this.cache.delete(farthest);
    }
  }
  private assertSession(session: DecodeSession): void {
    if (this.disposed) throw new Error('映像は閉じられています');
    if (session.failure) throw session.failure;
    if (this.session !== session) throw new Error('映像の復号を取り消しました');
  }
  private async waitForDecoder(session: DecodeSession, target: number): Promise<void> {
    let check!: () => void;
    const progress = new Promise<void>((resolve, reject) => {
      check = () => {
        try {
          this.assertSession(session);
          if (this.cache.has(target) || session.decoder.decodeQueueSize === 0) resolve();
        } catch (error) { reject(error); }
      };
      session.listeners.add(check); check();
    });
    try { await this.awaitWork(progress, 'decode'); } finally { session.listeners.delete(check); }
  }
  private awaitWork<T>(work: Promise<T>, stage: DecodeStage): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return; settled = true; clearTimeout(timeout); this.pending.delete(cancel); action();
      };
      const cancel = (error: Error) => finish(() => reject(error));
      const timeout = setTimeout(() => cancel(decodeTimeoutError(stage, this.bytes.origin)), DECODE_PROGRESS_TIMEOUT_MS);
      this.pending.add(cancel);
      work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (this.disposed) cancel(new Error('映像は閉じられています'));
    });
  }
  private closeSession(reason = new Error('映像の復号を取り消しました')): void {
    this.clearIdleTimer();
    const session = this.session; this.session = undefined;
    if (!session) return;
    session.prefetch?.request.abort(); session.prefetch = undefined;
    session.failure ??= reason;
    try { if (session.decoder.state !== 'closed') session.decoder.close(); }
    finally { for (const notify of session.listeners) notify(); session.listeners.clear(); }
  }
  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
  dispose(): void {
    this.disposed = true;
    for (const cancel of this.pending) cancel(new Error('映像は閉じられています'));
    this.closeSession();
    for (const frame of this.cache.values()) frame.close();
    this.cache.clear(); this.cacheBytes = 0;
  }
}

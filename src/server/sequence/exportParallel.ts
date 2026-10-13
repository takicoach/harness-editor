/** Parallel export (parallel export design, steps 3-5): one manager feeds the one
 * encoder in frame order; N workers (each its own browser and drawing surface) draw fixed blocks of L frames,
 * worker j blocks j, j+N, j+2N… in order, into a bounded queue of its own. The manager only ever waits on the
 * worker that owns the next frame, whose queue head is that frame, so the earliest block always progresses. */
import { execFileSync } from 'node:child_process';
import { availableParallelism, totalmem } from 'node:os';
import type { RenderSurface } from './exportRunner';

export interface ExportParallel { workers: number; blockFrames: number }
/** Step 5: L=60; N=4 was fastest and N above 4 is not measured. */
export const EXPORT_BLOCK_FRAMES_DEFAULT = 60, EXPORT_WORKERS_DEFAULT_MAX = 4;
/** Measured at a 1920×1080 drawing surface: Chromium, retained frames and the queue of one worker. */
export const EXPORT_WORKER_BYTES_FULL_HD = 1.3 * 1024 ** 3;
const MAX_WORKERS = 8, MAX_BLOCK_FRAMES = 100_000, FULL_HD_PIXELS = 1920 * 1080;

export interface ExportMachine { cores: number; totalmem: number }
/** Default N = min(4, performance cores, memory limit). A worker's memory scales with the drawing surface
 * (`doc.resolution`), but never below the 1920×1080 estimate (the browser itself does not shrink); all workers
 * together stay within half of the RAM. Never fewer than 1. */
export function defaultExportWorkers({ cores, totalmem: memory, resolution }: ExportMachine & { resolution: { width: number; height: number } }): number {
  const perWorker = EXPORT_WORKER_BYTES_FULL_HD * Math.max(1, (resolution.width * resolution.height) / FULL_HD_PIXELS);
  const byMemory = Math.floor(memory / 2 / perWorker);
  const workers = Math.min(EXPORT_WORKERS_DEFAULT_MAX, Math.floor(cores), byMemory);
  return Number.isFinite(workers) && workers >= 1 ? workers : 1;
}
/** Performance cores (macOS hw.perflevel0; elsewhere, or when unknown, every core) and total memory. */
export function exportMachine(): ExportMachine {
  let cores = 0;
  if (process.platform === 'darwin') {
    try { cores = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8', timeout: 2000 }).trim()); }
    catch { cores = 0; }
  }
  return { cores: Number.isSafeInteger(cores) && cores >= 1 ? cores : availableParallelism(), totalmem: totalmem() };
}

function setting(env: Record<string, string | undefined>, name: string, fallback: () => number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback();
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`書き出しの並列設定 ${name} が不正です: ${raw}（1〜${max}）`);
  return value;
}
/** N and L for an export of this drawing size. HARNESS_EXPORT_WORKERS (N) and HARNESS_EXPORT_BLOCK (L frames)
 * override the defaults; the machine is read only when N is not given. */
export function exportParallelSettings(resolution: { width: number; height: number }, env: Record<string, string | undefined> = process.env,
  machine: () => ExportMachine = exportMachine): ExportParallel {
  return { workers: setting(env, 'HARNESS_EXPORT_WORKERS', () => defaultExportWorkers({ ...machine(), resolution }), MAX_WORKERS),
    blockFrames: setting(env, 'HARNESS_EXPORT_BLOCK', () => EXPORT_BLOCK_FRAMES_DEFAULT, MAX_BLOCK_FRAMES) };
}
export function exportFrameWorker(frame: number, { workers, blockFrames }: ExportParallel): number {
  return Math.floor(frame / blockFrames) % workers;
}

/** Per-worker queue: at most `frames` images, counting the one being captured, and at most `bytes` of images. The byte
 * cap limits additional items: an empty queue always accepts one more, so an image larger than the cap still passes. */
export interface ExportQueueLimits { frames: number; bytes: number }
export const EXPORT_QUEUE_BYTES = 256 * 1024 * 1024;
export function exportQueueLimits(parallel: ExportParallel): ExportQueueLimits {
  return { frames: parallel.blockFrames, bytes: EXPORT_QUEUE_BYTES };
}

export interface ExportWorker { surface: RenderSurface; close(): Promise<void> }
export interface RenderedExportFrame { frame: number; image: Buffer; worker: number; samples?: unknown }
interface Spent { count: number; totalMs: number }
export interface ExportWorkerStats { worker: number; frames: number; blocks: number; openMs: number;
  /** Waiting for room in its full queue. */
  queueFullMs: number;
  /** Captures of the first frame of each block, and of every frame (including those). */
  blockStart: Spent; capture: Spent;
  decode?: unknown }
export interface ExportRenderStats { workers: ExportWorkerStats[];
  /** The manager waiting for the next frame: time the encoder had no new input. */
  managerWaitMs: number }

/** Marks errors the export itself failed with; the job records them as failed even if a cancel arrives later.
 * A registered symbol rather than a module-level set: separately bundled copies of this module agree on it. */
const failureMark = Symbol.for('harness-editor.exportFailure');
export function isExportFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[failureMark] === true;
}
function failureOf(error: unknown): Error {
  let value = error instanceof Error ? error : new Error(String(error));
  try { Object.defineProperty(value, failureMark, { value: true }); }
  catch { value = new Error(value.message, { cause: value }); Object.defineProperty(value, failureMark, { value: true }); }
  return value;
}

/** Resolves when condition() holds (checked on each notify), rejects with the stop reason. */
function until(condition: () => boolean, waiters: Set<() => void>, stop: AbortSignal): Promise<void> {
  if (stop.aborted) return Promise.reject(stop.reason);
  if (condition()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { waiters.delete(check); stop.removeEventListener('abort', check); };
    const check = () => {
      if (stop.aborted) { done(); reject(stop.reason); }
      else if (condition()) { done(); resolve(); }
    };
    waiters.add(check); stop.addEventListener('abort', check);
  });
}
function notify(waiters: Set<() => void>): void { for (const check of [...waiters]) check(); }
/** The work's result, or the stop reason as soon as the stop comes (the work is left to the caller's cleanup). */
function unlessStopped<T>(work: Promise<T>, stop: AbortSignal): Promise<T> {
  if (stop.aborted) { void work.catch(() => undefined); return Promise.reject(stop.reason); }
  return new Promise((resolve, reject) => {
    const onStop = () => reject(stop.reason);
    stop.addEventListener('abort', onStop, { once: true });
    work.then(value => { stop.removeEventListener('abort', onStop); resolve(value); }, error => { stop.removeEventListener('abort', onStop); reject(error); });
  });
}

interface Queued { frame: number; image: Buffer; samples?: unknown }
/**
 * Draw `frames` frames with up to N workers and hand them to `frame()` strictly in order, one at a time.
 * Stops at the first of: the caller's cancel (rejects with signal.reason), a worker's or frame()'s error, or
 * `watch` settling (the encoder exiting early) — then rejects with that first error, marked by isExportFailure().
 * Every wait is released on a stop: queue room, the next frame, a draw (its worker is closed), frame() itself
 * (`stopped` lets the caller end it, e.g. kill the encoder) and a worker still opening (open's signal). It settles
 * only after every worker that opened, including one that opened late, has been closed.
 */
export async function renderExportFrames(options: {
  parallel: ExportParallel; frames: number; signal: AbortSignal;
  open(worker: number, signal: AbortSignal): Promise<ExportWorker>;
  limits?: ExportQueueLimits;
  frame(item: RenderedExportFrame): Promise<void>;
  watch?: Promise<unknown>;
  stopped?(reason: unknown): void;
  /** Measurement: read each worker's decoder counters before closing it. */
  decodeStats?: boolean;
}): Promise<ExportRenderStats> {
  const { parallel, frames, signal, open, frame: deliver, watch, stopped } = options;
  const limits = options.limits ?? exportQueueLimits(parallel);
  signal.throwIfAborted();
  if (![parallel.workers, parallel.blockFrames, limits.frames, limits.bytes].every(value => Number.isSafeInteger(value) && value >= 1))
    throw new Error(`書き出しの並列設定が不正です（描き手 ${parallel.workers}・ブロック ${parallel.blockFrames}）`);
  const blocks = Math.ceil(frames / parallel.blockFrames), count = Math.min(parallel.workers, blocks);
  const stop = new AbortController();
  let failure: Error | undefined, finished = false;
  const halt = (reason: unknown) => {
    if (stop.signal.aborted) return;
    stop.abort(reason);
    try { stopped?.(reason); } catch (error) { console.warn('[sme] 書き出しの停止処理でエラーが起きました:', error); }
  };
  const fail = (error: unknown) => { if (stop.signal.aborted) return; failure = failureOf(error); halt(failure); };
  const cancel = () => halt(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  watch?.then(() => { if (!finished) fail(new Error('動画の符号化が最後のコマの前に終わりました')); }, error => { if (!finished) fail(error); });

  const queues = Array.from({ length: count }, () => ({ items: [] as Queued[], bytes: 0, lastBytes: 0, waiters: new Set<() => void>() }));
  const stats: ExportRenderStats = { managerWaitMs: 0, workers: queues.map((_, worker) => ({ worker, frames: 0, blocks: 0, openMs: 0, queueFullMs: 0,
    blockStart: { count: 0, totalMs: 0 }, capture: { count: 0, totalMs: 0 } })) };
  const handles: Array<ExportWorker | undefined> = [], closing = new Map<number, Promise<void>>();
  const close = (worker: number) => {
    const handle = handles[worker];
    if (!handle) return Promise.resolve();
    if (!closing.has(worker)) closing.set(worker, handle.close().catch(() => undefined));
    return closing.get(worker)!;
  };
  // A stop closes every open worker at once: that is what ends a draw in progress.
  stop.signal.addEventListener('abort', () => { for (let worker = 0; worker < count; worker++) void close(worker); }, { once: true });

  const run = async (worker: number) => {
    const queue = queues[worker]!, stat = stats.workers[worker]!;
    try {
      const opening = performance.now();
      const handle = await open(worker, stop.signal);
      handles[worker] = handle; stat.openMs = performance.now() - opening;
      if (stop.signal.aborted) return;
      for (let block = worker; block < blocks; block += count) {
        const first = block * parallel.blockFrames, end = Math.min(first + parallel.blockFrames, frames);
        for (let frame = first; frame < end; frame++) {
          const waiting = performance.now();
          await until(() => queue.items.length < limits.frames && (queue.items.length === 0 || queue.bytes + queue.lastBytes <= limits.bytes), queue.waiters, stop.signal);
          const capturing = performance.now(); stat.queueFullMs += capturing - waiting;
          const image = await handle.surface.capture(frame);
          const samples = handle.surface.samples?.(), spent = performance.now() - capturing;
          stop.signal.throwIfAborted();
          stat.capture.count++; stat.capture.totalMs += spent; stat.frames++;
          if (frame === first) { stat.blockStart.count++; stat.blockStart.totalMs += spent; }
          queue.items.push({ frame, image, ...(samples === undefined ? {} : { samples }) }); queue.bytes += image.length; queue.lastBytes = image.length;
          notify(queue.waiters);
        }
        stat.blocks++;
      }
      if (options.decodeStats) stat.decode = await handle.surface.decodeStats?.() ?? null;
    } catch (error) { fail(error); }
    finally { await close(worker); }
  };
  const running = queues.map((_, worker) => run(worker));
  try {
    for (let frame = 0; frame < frames; frame++) {
      const worker = exportFrameWorker(frame, parallel), queue = queues[worker]!;
      const waiting = performance.now();
      await until(() => queue.items.length > 0, queue.waiters, stop.signal);
      stats.managerWaitMs += performance.now() - waiting;
      const item = queue.items.shift()!; queue.bytes -= item.image.length; notify(queue.waiters);
      if (item.frame !== frame) throw new Error(`書き出しのコマの順序が崩れました（${frame + 1} コマ目の代わりに ${item.frame + 1} コマ目）`);
      await unlessStopped(deliver({ frame, image: item.image, worker, ...(item.samples === undefined ? {} : { samples: item.samples }) }), stop.signal);
    }
    finished = true;
  } catch (error) { fail(error); }
  await Promise.allSettled(running);
  finished = true;
  signal.removeEventListener('abort', cancel);
  if (stop.signal.aborted) throw failure ?? stop.signal.reason;
  return stats;
}

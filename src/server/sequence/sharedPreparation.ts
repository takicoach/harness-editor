import {ffmpegLane,raiseLane,type FfmpegLane,type FfmpegPriority} from './ffmpegGate';
interface Pending<T> { work: Promise<T>; controller: AbortController; consumers: number; settled: boolean; lane: FfmpegLane }

/** Requests share preparation work, but each request owns only its own cancellation.
 * The lane carries the most urgent joined caller's FFmpeg priority (設計 §2-1). */
export class SharedPreparations<T> {
  private pending = new Map<string, Pending<T>>();
  get(key: string, start: (signal: AbortSignal, lane: FfmpegLane) => Promise<T>, signal?: AbortSignal, priority: FfmpegPriority = 'audio'): Promise<T> {
    signal?.throwIfAborted();
    let preparation = this.pending.get(key);
    if (!preparation || preparation.controller.signal.aborted) {
      const controller = new AbortController(), lane = ffmpegLane(priority);
      preparation = { work: Promise.resolve().then(() => { controller.signal.throwIfAborted(); return start(controller.signal, lane); }), controller, consumers: 0, settled: false, lane };
      const entry = preparation;
      const cleanup = () => { entry.settled = true; if (this.pending.get(key) === entry) this.pending.delete(key); };
      void entry.work.then(cleanup, cleanup);
      this.pending.set(key, entry);
    } else raiseLane(preparation.lane, priority);
    return this.join(preparation, signal);
  }
  /** 進行中の準備があれば順位だけを上げる（合流はしない）。急ぐ呼び手が、他の準備が待っている下ごしらえを急がせるため。 */
  raise(key: string, priority: FfmpegPriority): void {
    const preparation = this.pending.get(key);
    if (preparation && !preparation.controller.signal.aborted) raiseLane(preparation.lane, priority);
  }
  private join(preparation: Pending<T>, signal?: AbortSignal): Promise<T> {
    preparation.consumers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (success: boolean, value: unknown) => {
        if (finished) return;
        finished = true; signal?.removeEventListener('abort', abort); preparation.consumers--;
        if (!preparation.consumers && !preparation.settled) preparation.controller.abort();
        if (success) resolve(value as T); else reject(value);
      };
      const abort = () => finish(false, signal!.reason ?? new Error('準備を中止しました'));
      signal?.addEventListener('abort', abort, { once: true });
      preparation.work.then(result => finish(true, result), error => finish(false, error));
      if (signal?.aborted) abort();
    });
  }
}

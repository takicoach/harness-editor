interface Pending<T> { work: Promise<T>; controller: AbortController; consumers: number; settled: boolean }

/** Requests share preparation work, but each request owns only its own cancellation. */
export class SharedPreparations<T> {
  private pending = new Map<string, Pending<T>>();
  get(key: string, start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let preparation = this.pending.get(key);
    if (!preparation || preparation.controller.signal.aborted) {
      const controller = new AbortController();
      preparation = { work: Promise.resolve().then(() => { controller.signal.throwIfAborted(); return start(controller.signal); }), controller, consumers: 0, settled: false };
      const entry = preparation;
      const cleanup = () => { entry.settled = true; if (this.pending.get(key) === entry) this.pending.delete(key); };
      void entry.work.then(cleanup, cleanup);
      this.pending.set(key, entry);
    }
    return this.join(preparation, signal);
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

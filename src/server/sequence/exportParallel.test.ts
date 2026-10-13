import { expect, it } from 'vitest';
import { availableParallelism } from 'node:os';
import { EXPORT_BLOCK_FRAMES_DEFAULT, defaultExportWorkers, exportFrameWorker, exportMachine, exportParallelSettings, isExportFailure, renderExportFrames, type ExportWorker } from './exportParallel';

/** A promise with its settle functions. */
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Mocked workers: each capture returns [frame, worker, ...padding]. `gate` can hold a capture until released;
 * close() rejects a capture still in progress, as closing a browser does. */
function fakeWorkers(options: { size?: (frame: number) => number; gate?: (frame: number, worker: number) => Promise<void> | undefined;
  fail?: { worker: number; frame: number; error: Error }; failOpen?: number; openGate?: (worker: number) => Promise<void> | undefined } = {}) {
  const log: string[] = [], captured = new Map<number, number[]>(), closed: number[] = [];
  const pending = new Map<number, (error: Error) => void>();
  const open = async (worker: number): Promise<ExportWorker> => {
    log.push(`open ${worker}`);
    await options.openGate?.(worker);
    if (options.failOpen === worker) throw new Error(`open ${worker} failed`);
    let closing: Promise<void> | undefined;
    return {
      surface: {
        async capture(frame) {
          captured.set(worker, [...captured.get(worker) ?? [], frame]);
          const held = options.gate?.(frame, worker);
          if (held) await new Promise<void>((resolve, reject) => { pending.set(worker, reject); held.then(resolve, reject); });
          pending.delete(worker);
          if (closing) throw new Error(`worker ${worker} closed`);
          if (options.fail?.worker === worker && options.fail.frame === frame) throw options.fail.error;
          const image = Buffer.alloc(options.size?.(frame) ?? 2); image[0] = frame % 256; image[1] = worker; return image;
        },
        decodeStats: async () => ({ worker }),
      },
      close() {
        closing ??= (async () => { closed.push(worker); pending.get(worker)?.(new Error(`worker ${worker} closed`)); })();
        return closing;
      },
    };
  };
  return { log, captured, closed, open };
}

const GiB = 1024 ** 3, fullHd = { width: 1920, height: 1080 };
it('default N = min(4, performance cores, memory limit): ~1.3 GB per worker at 1920×1080, scaled by pixels, within half of RAM, never below 1', () => {
  expect(defaultExportWorkers({ cores: 4, totalmem: 24 * GiB, resolution: fullHd })).toBe(4); // this Mac (step 5)
  expect(defaultExportWorkers({ cores: 12, totalmem: 64 * GiB, resolution: fullHd })).toBe(4);
  expect(defaultExportWorkers({ cores: 2, totalmem: 64 * GiB, resolution: fullHd })).toBe(2);
  expect(defaultExportWorkers({ cores: 8, totalmem: 8 * GiB, resolution: fullHd })).toBe(3); // 4 GiB / 1.3 GiB
  expect(defaultExportWorkers({ cores: 8, totalmem: 16 * GiB, resolution: { width: 3840, height: 2160 } })).toBe(1); // 8 / 5.2
  expect(defaultExportWorkers({ cores: 8, totalmem: 32 * GiB, resolution: { width: 3840, height: 2160 } })).toBe(3); // 16 / 5.2
  expect(defaultExportWorkers({ cores: 8, totalmem: 32 * GiB, resolution: { width: 2704, height: 1520 } })).toBe(4); // 2.7K: 16 / 2.6
  // A smaller frame does not shrink the browser itself: no more than the 1920×1080 estimate allows.
  expect(defaultExportWorkers({ cores: 8, totalmem: 6 * GiB, resolution: { width: 1280, height: 720 } })).toBe(2);
  for (const machine of [{ cores: 8, totalmem: 1 * GiB }, { cores: 0, totalmem: 64 * GiB }, { cores: Number.NaN, totalmem: Number.NaN }])
    expect(defaultExportWorkers({ ...machine, resolution: fullHd })).toBe(1);
});
it('settings: the machine decides N unless HARNESS_EXPORT_WORKERS is set, L=60 unless HARNESS_EXPORT_BLOCK is set, bad values rejected', () => {
  const machine = () => ({ cores: 8, totalmem: 24 * GiB });
  expect(EXPORT_BLOCK_FRAMES_DEFAULT).toBe(60);
  expect(exportParallelSettings(fullHd, {}, machine)).toEqual({ workers: 4, blockFrames: 60 });
  expect(exportParallelSettings(fullHd, {}, () => ({ cores: 2, totalmem: 24 * GiB }))).toEqual({ workers: 2, blockFrames: 60 });
  expect(exportParallelSettings(fullHd, { HARNESS_EXPORT_WORKERS: '1', HARNESS_EXPORT_BLOCK: '30' }, () => { throw new Error('not asked'); })).toEqual({ workers: 1, blockFrames: 30 });
  expect(exportParallelSettings(fullHd, { HARNESS_EXPORT_WORKERS: '6' }, machine)).toEqual({ workers: 6, blockFrames: 60 });
  for (const bad of [{ HARNESS_EXPORT_WORKERS: '0' }, { HARNESS_EXPORT_WORKERS: '9' }, { HARNESS_EXPORT_WORKERS: '1.5' }, { HARNESS_EXPORT_BLOCK: '0' }, { HARNESS_EXPORT_BLOCK: 'x' }])
    expect(() => exportParallelSettings(fullHd, bad, machine)).toThrow(/書き出し/);
});
it('reads this machine: performance cores and total memory, both positive', () => {
  const machine = exportMachine();
  expect(Number.isSafeInteger(machine.cores) && machine.cores >= 1).toBe(true);
  expect(machine.totalmem).toBeGreaterThan(0);
  if (process.platform === 'darwin') expect(machine.cores).toBeLessThanOrEqual(availableParallelism());
});
it('gives block floor(frame / L) to worker (block mod N), independent of N for the block itself', () => {
  expect(Array.from({ length: 13 }, (_, frame) => exportFrameWorker(frame, { workers: 2, blockFrames: 3 }))).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0]);
  expect(Array.from({ length: 5 }, (_, frame) => exportFrameWorker(frame, { workers: 1, blockFrames: 2 }))).toEqual([0, 0, 0, 0, 0]);
});

it('N=1: one worker draws every frame in order and the frames reach the encoder in order', async () => {
  const workers = fakeWorkers(), seen: number[] = [];
  const stats = await renderExportFrames({ parallel: { workers: 1, blockFrames: 4 }, frames: 10, signal: new AbortController().signal, open: workers.open,
    frame: async item => { seen.push(item.frame); expect(item.worker).toBe(0); expect(item.image[0]).toBe(item.frame); }, decodeStats: true });
  expect(workers.log).toEqual(['open 0']);
  expect(workers.captured.get(0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(workers.closed).toEqual([0]);
  expect(stats.workers.map(worker => worker.decode)).toEqual([{ worker: 0 }]);
});

it('N workers: worker j draws blocks j, j+N… in order; the encoder gets every frame once, in order, from its owner', async () => {
  // Uneven, shuffled delays so workers finish out of order.
  const delay = (frame: number) => new Promise<void>(resolve => setTimeout(resolve, (frame * 7) % 5));
  const workers = fakeWorkers({ gate: delay }), seen: Array<[number, number]> = [];
  const parallel = { workers: 3, blockFrames: 2 };
  await renderExportFrames({ parallel, frames: 13, signal: new AbortController().signal, open: workers.open, limits: { frames: 2, bytes: 1 << 20 },
    frame: async item => { seen.push([item.frame, item.image[1]!]); expect(item.image[0]).toBe(item.frame); } });
  expect(seen.map(([frame]) => frame)).toEqual(Array.from({ length: 13 }, (_, frame) => frame));
  expect(seen.map(([frame, worker]) => worker === exportFrameWorker(frame, parallel))).not.toContain(false);
  expect(workers.captured.get(0)).toEqual([0, 1, 6, 7, 12]);
  expect(workers.captured.get(1)).toEqual([2, 3, 8, 9]);
  expect(workers.captured.get(2)).toEqual([4, 5, 10, 11]);
  expect(workers.closed.sort()).toEqual([0, 1, 2]);
});

it('opens only as many workers as there are blocks', async () => {
  const workers = fakeWorkers();
  await renderExportFrames({ parallel: { workers: 4, blockFrames: 5 }, frames: 9, signal: new AbortController().signal, open: workers.open, frame: async () => undefined });
  expect(workers.log.sort()).toEqual(['open 0', 'open 1']);
});

it('a full queue stalls only its worker; the slow owner of the head block still finishes, without deadlock', async () => {
  // Worker 0 (head block) holds frame 0 until worker 1 has filled its queue and is waiting for room.
  const release = deferred(), outstanding = new Map<number, number>(), consumed: number[] = [];
  let maxOutstanding = 0, worker1Blocked = false;
  const parallel = { workers: 2, blockFrames: 4 }, limits = { frames: 2, bytes: 1 << 20 };
  const workers = fakeWorkers({ gate: (frame, worker) => {
    // Each capture start counts the frames this worker holds: queued plus this one in flight.
    const held = (outstanding.get(worker) ?? 0) + 1; outstanding.set(worker, held); maxOutstanding = Math.max(maxOutstanding, held);
    if (worker === 0 && frame === 0) return release.promise;
    return undefined;
  } });
  const done = renderExportFrames({ parallel, frames: 16, signal: new AbortController().signal, open: workers.open, limits,
    frame: async item => { consumed.push(item.frame); outstanding.set(item.worker, outstanding.get(item.worker)! - 1); } });
  for (let i = 0; i < 20; i++) await tick();
  worker1Blocked = workers.captured.get(1)?.length === 2;
  expect(worker1Blocked).toBe(true); // frames 4 and 5 drawn, then no room for 6
  expect(consumed).toEqual([]);
  release.resolve();
  await done;
  expect(consumed).toEqual(Array.from({ length: 16 }, (_, frame) => frame));
  expect(maxOutstanding).toBeLessThanOrEqual(limits.frames);
});

it('counts bytes of queued images and the one in flight; a single image over the byte cap still passes', async () => {
  const parallel = { workers: 2, blockFrames: 4 }, outstanding = new Map<number, number>();
  // Bytes a worker holds: produced (when the fake makes the image) minus consumed by the encoder.
  const sizes = (frame: number) => {
    const size = frame === 3 ? 100 : 4, worker = exportFrameWorker(frame, parallel);
    outstanding.set(worker, (outstanding.get(worker) ?? 0) + size); return size;
  };
  let violation = '';
  const limits = { frames: 100, bytes: 10 }, release = deferred();
  const workers = fakeWorkers({ size: sizes, gate: (frame, worker) => {
    const held = outstanding.get(worker) ?? 0;
    // A capture may start with an empty queue, or when queued bytes plus this worker's last PNG fit in the cap.
    if (held > 0 && held + 4 > limits.bytes) violation = `worker ${worker} started frame ${frame} holding ${held} bytes`;
    if (worker === 0 && frame === 0) return release.promise;
    return undefined;
  } });
  const seen: number[] = [];
  const done = renderExportFrames({ parallel, frames: 16, signal: new AbortController().signal, open: workers.open, limits,
    frame: async item => { seen.push(item.frame); outstanding.set(item.worker, outstanding.get(item.worker)! - item.image.length); } });
  for (let i = 0; i < 20; i++) await tick();
  // Worker 1 drew frames 4 and 5 (4 + 4 = 8 bytes held) and waits: 8 + 4 > 10.
  expect(workers.captured.get(1)).toEqual([4, 5]);
  release.resolve();
  await done;
  expect(violation).toBe('');
  expect(seen).toEqual(Array.from({ length: 16 }, (_, frame) => frame));
});

it('the first failure wins, stops every worker (also one blocked in a draw) and is marked as a failure, not a cancel', async () => {
  const never = new Promise<void>(() => undefined), stopped: unknown[] = [];
  const failure = new Error('frame 5 exploded');
  // Blocks of 2: worker 0 draws 0,1,4,5…, worker 1 draws 2,3,6,7…. Worker 0 hangs in its draw of frame 4; worker 1 fails at 6.
  const workers = fakeWorkers({ gate: (frame, worker) => (worker === 0 && frame === 4 ? never : undefined), fail: { worker: 1, frame: 6, error: failure } });
  const result = renderExportFrames({ parallel: { workers: 2, blockFrames: 2 }, frames: 12, signal: new AbortController().signal, open: workers.open,
    limits: { frames: 4, bytes: 1 << 20 }, frame: async () => undefined, stopped: reason => { stopped.push(reason); } });
  await expect(result).rejects.toBe(failure);
  expect(isExportFailure(failure)).toBe(true);
  expect(stopped).toEqual([failure]);
  expect(workers.closed.sort()).toEqual([0, 1]);
});

it('a failure of the encoder write (the frame callback) is the job failure', async () => {
  const workers = fakeWorkers(), failure = new Error('pipe closed');
  await expect(renderExportFrames({ parallel: { workers: 2, blockFrames: 2 }, frames: 12, signal: new AbortController().signal, open: workers.open,
    frame: async item => { if (item.frame === 3) throw failure; } })).rejects.toBe(failure);
  expect(isExportFailure(failure)).toBe(true);
  expect(workers.closed.sort()).toEqual([0, 1]);
});

it('a worker that fails to open fails the job and the open ones are closed', async () => {
  const workers = fakeWorkers({ failOpen: 1 });
  const error = await renderExportFrames({ parallel: { workers: 3, blockFrames: 2 }, frames: 12, signal: new AbortController().signal, open: workers.open,
    frame: async () => undefined }).then(() => new Error('resolved'), (value: Error) => value);
  expect(error.message).toBe('open 1 failed'); expect(isExportFailure(error)).toBe(true);
  expect(workers.closed.sort()).toEqual([0, 2]);
});

it('the encoder exiting before the last frame fails the job, even while the manager waits for a slow worker', async () => {
  const exited = deferred(), never = new Promise<void>(() => undefined);
  const workers = fakeWorkers({ gate: (frame) => (frame === 1 ? never : undefined) });
  const result = renderExportFrames({ parallel: { workers: 2, blockFrames: 2 }, frames: 12, signal: new AbortController().signal, open: workers.open,
    frame: async () => undefined, watch: exited.promise });
  await tick(); exited.resolve();
  const error = await result.then(() => new Error('resolved'), (value: Error) => value);
  expect(error.message).toMatch(/符号化/); expect(isExportFailure(error)).toBe(true);
  expect(workers.closed.sort()).toEqual([0, 1]);
  // And with the encoder's own error.
  const crashed = deferred(), own = new Error('動画の符号化に失敗しました: boom'), more = fakeWorkers({ gate: frame => (frame === 1 ? never : undefined) });
  const second = renderExportFrames({ parallel: { workers: 2, blockFrames: 2 }, frames: 12, signal: new AbortController().signal, open: more.open,
    frame: async () => undefined, watch: crashed.promise });
  await tick(); crashed.reject(own);
  await expect(second).rejects.toBe(own);
});

it('cancel releases every wait (next frame, full queue, draw, encoder write) and rejects with the cancel reason', async () => {
  const controller = new AbortController(), never = new Promise<void>(() => undefined), stopped: unknown[] = [];
  let writing = false;
  // Worker 1 hangs in its draw of frame 2; worker 0 fills its queue (4, 5); the manager waits in a write that never ends.
  let drawing = false;
  const workers = fakeWorkers({ gate: (frame, worker) => { if (worker === 1 && frame === 2) { drawing = true; return never; } return undefined; } });
  const result = renderExportFrames({ parallel: { workers: 2, blockFrames: 2 }, frames: 40, signal: controller.signal, open: workers.open,
    limits: { frames: 2, bytes: 1 << 20 }, stopped: reason => { stopped.push(reason); },
    frame: async item => { if (item.frame === 1) { writing = true; await never; } } });
  for (let i = 0; i < 20; i++) await tick();
  expect(writing).toBe(true); expect(drawing).toBe(true); expect(workers.captured.get(0)).toEqual([0, 1, 4, 5]);
  const reason = new Error('cancelled by user');
  controller.abort(reason);
  await expect(result).rejects.toBe(reason);
  expect(isExportFailure(reason)).toBe(false);
  expect(stopped).toEqual([reason]);
  expect(workers.closed.sort()).toEqual([0, 1]);
});

it('a worker launch that finishes after the cancel is closed, and the job waits for it', async () => {
  const controller = new AbortController(), launch = deferred();
  const workers = fakeWorkers({ openGate: worker => (worker === 1 ? launch.promise : undefined) });
  let settled = false;
  const result = renderExportFrames({ parallel: { workers: 2, blockFrames: 2 }, frames: 12, signal: controller.signal, open: workers.open, frame: async () => undefined })
    .catch(error => error).finally(() => { settled = true; });
  await tick(); controller.abort(new Error('cancel'));
  for (let i = 0; i < 5; i++) await tick();
  expect(settled).toBe(false); // still waiting for the launch of worker 1
  expect(workers.closed).toEqual([0]);
  launch.resolve();
  expect((await result as Error).message).toBe('cancel');
  expect(workers.closed.sort()).toEqual([0, 1]);
});

it('passes a stop signal to open, so a slow launch can be cut short', async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const result = renderExportFrames({ parallel: { workers: 1, blockFrames: 2 }, frames: 4, signal: controller.signal, frame: async () => undefined,
    open: (_worker, signal) => { seen = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('launch aborted')), { once: true })); } });
  await tick(); controller.abort(new Error('cancel'));
  await expect(result).rejects.toThrow('cancel');
  expect(seen?.aborted).toBe(true);
});

it('reports queue waits, manager waits and block starts for measurement', async () => {
  const workers = fakeWorkers();
  const stats = await renderExportFrames({ parallel: { workers: 2, blockFrames: 3 }, frames: 12, signal: new AbortController().signal, open: workers.open,
    frame: async () => undefined });
  expect(stats.workers).toHaveLength(2);
  expect(stats.workers.map(worker => [worker.frames, worker.blocks])).toEqual([[6, 2], [6, 2]]);
  for (const worker of stats.workers) {
    expect(worker.queueFullMs).toBeGreaterThanOrEqual(0); expect(worker.openMs).toBeGreaterThanOrEqual(0);
    expect(worker.blockStart.count).toBe(2); expect(worker.capture.count).toBe(6);
  }
  expect(stats.managerWaitMs).toBeGreaterThanOrEqual(0);
});

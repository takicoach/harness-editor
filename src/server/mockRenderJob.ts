import { basename } from 'node:path';
import type { RenderJob, RenderJobEvent } from './renderJobTypes';

interface MockRun { job: RenderJob; timers: Set<ReturnType<typeof setTimeout>> }
interface Subscription { listener: (event: RenderJobEvent) => void }

/** UI fixtures only. No child process, install, renderer or output-file writes. */
export class MockRenderJobManager {
  private readonly runs = new Map<string, MockRun>();
  private readonly terminal = new Map<string, RenderJob>();
  private readonly subscribers = new Map<string, Set<Subscription>>();
  private readonly notifications: Array<{ projectId: string; event: RenderJobEvent; recipients: Subscription[] }> = [];
  private notifying = false;
  private stopping = false;
  private readonly delayMs: number;
  constructor(delayMs = 3000, private readonly shouldFail = false) {
    this.delayMs = Number.isFinite(delayMs) ? Math.max(0, Math.min(delayMs, 2147483647)) : 3000;
  }
  exists(projectId: string): boolean { return this.runs.has(projectId); }
  activeCount(): number { return this.runs.size; }
  get(projectId: string): RenderJob | undefined {
    const job = this.runs.get(projectId)?.job;
    return job ? structuredClone(job) : undefined;
  }
  getSnapshot(projectId: string): RenderJob | undefined {
    const job = this.runs.get(projectId)?.job ?? this.terminal.get(projectId);
    return job ? structuredClone(job) : undefined;
  }
  start(projectId: string, options: { finalOutput: string }): RenderJob {
    if (this.stopping) throw new Error('render-shutting-down');
    if (this.exists(projectId)) throw new Error('already-running');
    this.terminal.delete(projectId);
    const run: MockRun = { job: { projectId, outputFile: basename(options.finalOutput), startedAt: Date.now(), phase: 'preparing' }, timers: new Set() };
    this.runs.set(projectId, run);
    if (this.shouldFail) {
      this.schedule(run, this.delayMs, () => this.publish(run, {
        phase: 'failed', error: { code: 'render-failed', message: 'Mock render failure (SME_RENDER_MOCK_FAIL=1)' },
      }));
    } else {
      for (const percent of [25, 50, 75, 100]) this.schedule(run, this.delayMs * percent / 100, () => {
        this.publish(run, { phase: 'rendering', progress: { frames: percent, total: 100, percent } });
        if (percent === 100) this.publish(run, { phase: 'done' });
      });
    }
    return structuredClone(run.job);
  }
  warn(projectId: string, message: string): boolean {
    const run = this.runs.get(projectId);
    if (!run) return false;
    this.publish(run, { phase: run.job.phase, warning: message });
    return true;
  }
  cancel(projectId: string): boolean {
    const run = this.runs.get(projectId);
    if (!run) return false;
    this.publish(run, { phase: 'cancelled' });
    return true;
  }
  // Both managers release terminal runs themselves. An SSE observation of an
  // earlier run must never cancel a newer run sharing the same project id.
  discard(_projectId: string): void {}
  killAll(): void {
    if (this.stopping) return;
    this.stopping = true;
    try { for (const projectId of [...this.runs.keys()]) this.cancel(projectId); }
    finally { this.stopping = false; }
  }
  subscribe(projectId: string, listener: (event: RenderJobEvent) => void): () => void {
    let listeners = this.subscribers.get(projectId);
    if (!listeners) { listeners = new Set(); this.subscribers.set(projectId, listeners); }
    const subscription = { listener };
    listeners.add(subscription);
    return () => {
      listeners.delete(subscription);
      if (listeners.size === 0 && this.subscribers.get(projectId) === listeners) this.subscribers.delete(projectId);
    };
  }
  private schedule(run: MockRun, delay: number, callback: () => void): void {
    const timer = setTimeout(() => {
      run.timers.delete(timer);
      if (this.runs.get(run.job.projectId) === run) callback();
    }, delay);
    run.timers.add(timer);
  }
  private clear(run: MockRun): void {
    for (const timer of run.timers) clearTimeout(timer);
    run.timers.clear();
    if (this.runs.get(run.job.projectId) === run) this.runs.delete(run.job.projectId);
  }
  private publish(run: MockRun, event: RenderJobEvent): void {
    if (this.runs.get(run.job.projectId) !== run) return;
    Object.assign(run.job, event);
    if (event.phase === 'done' || event.phase === 'failed' || event.phase === 'cancelled') {
      this.terminal.set(run.job.projectId, structuredClone(run.job));
      // Clear before notifying: a subscriber may synchronously start the next run.
      this.clear(run);
    }
    this.notifications.push({ projectId: run.job.projectId, event: structuredClone(event),
      recipients: [...(this.subscribers.get(run.job.projectId) ?? [])] });
    if (this.notifying) return;
    this.notifying = true;
    try {
      // A subscriber can cancel synchronously. Finish the current notification
      // first, so other subscribers cannot receive old progress after cancelled.
      while (this.notifications.length) {
        const next = this.notifications.shift()!;
        for (const subscription of next.recipients) {
          // New or reconnected tabs must not receive a prior run's queued event.
          if (!this.subscribers.get(next.projectId)?.has(subscription)) continue;
          try { subscription.listener(structuredClone(next.event)); }
          catch (error) { console.warn('mockRenderJob: 進捗の通知に失敗しました', error); }
        }
      }
    } finally { this.notifying = false; }
  }
}

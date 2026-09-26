import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockRenderJobManager } from './mockRenderJob';
import type { RenderJobEvent } from './renderJobTypes';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
const options = { finalOutput: '/private/test/out/fixture.mp4' };

it('keeps progress, warning and completion available to returning subscribers', () => {
  const jobs = new MockRenderJobManager(400), events: RenderJobEvent[] = [];
  jobs.subscribe('project', event => events.push(event));
  expect(jobs.start('project', options).outputFile).toBe('fixture.mp4');
  expect(jobs.activeCount()).toBe(1);
  expect(() => jobs.start('project', options)).toThrow('already-running');
  jobs.warn('project', '検証用の注意');
  vi.advanceTimersByTime(200);
  expect(jobs.getSnapshot('project')?.progress?.percent).toBe(50);
  vi.advanceTimersByTime(200);
  expect(events.map(event => event.phase)).toEqual(['preparing', 'rendering', 'rendering', 'rendering', 'rendering', 'done']);
  expect(jobs.getSnapshot('project')).toMatchObject({ phase: 'done', warning: '検証用の注意', progress: { percent: 100 } });
  expect(jobs.get('project')).toBeUndefined();
  expect(jobs.activeCount()).toBe(0);
  expect(jobs.cancel('project')).toBe(false);
  expect(jobs.warn('project', '遅い通知')).toBe(false);
});

it('cancels only the owned run and cannot overwrite an immediate replacement with delayed ticks', () => {
  const jobs = new MockRenderJobManager(400), events: RenderJobEvent[] = [];
  jobs.subscribe('project', event => events.push(event));
  jobs.start('project', options);vi.advanceTimersByTime(150);
  expect(jobs.cancel('project')).toBe(true);
  const next = jobs.start('project', { finalOutput: '/private/next.mp4' });
  expect(next.phase).toBe('preparing');
  vi.advanceTimersByTime(250);
  expect(jobs.getSnapshot('project')).toMatchObject({ outputFile: 'next.mp4', phase: 'rendering', progress: { percent: 50 } });
  expect(events.filter(event => event.phase === 'done')).toHaveLength(0);
  vi.advanceTimersByTime(150);
  expect(events.filter(event => event.phase === 'done')).toHaveLength(1);
  expect(jobs.getSnapshot('project')?.outputFile).toBe('next.mp4');
});

it('a completion subscriber can start a new run without old cleanup deleting it', () => {
  const jobs = new MockRenderJobManager(100);let replaced = false;
  jobs.subscribe('project', event => {
    if (event.phase === 'done' && !replaced) { replaced = true;jobs.start('project', { finalOutput: '/private/second.mp4' }); }
  });
  jobs.start('project', options);vi.advanceTimersByTime(100);
  expect(jobs.getSnapshot('project')).toMatchObject({ outputFile: 'second.mp4', phase: 'preparing' });
  expect(jobs.activeCount()).toBe(1);vi.advanceTimersByTime(100);
  expect(jobs.getSnapshot('project')).toMatchObject({ outputFile: 'second.mp4', phase: 'done' });
});

it('isolates subscriber exceptions and mutable event/snapshot copies, including reserved-looking ids', () => {
  const jobs = new MockRenderJobManager(100), warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), events: RenderJobEvent[] = [];
  const unsubscribe = jobs.subscribe('error', event => { if (event.progress) event.progress.percent = -1;throw new Error('broken listener'); });
  jobs.subscribe('error', event => events.push(event));
  jobs.start('error', options);vi.advanceTimersByTime(25);
  expect(events[0]?.progress?.percent).toBe(25);expect(warn).toHaveBeenCalledTimes(1);
  const snapshot = jobs.getSnapshot('error')!;snapshot.progress!.percent = -2;
  expect(jobs.getSnapshot('error')?.progress?.percent).toBe(25);
  unsubscribe();vi.advanceTimersByTime(75);expect(warn).toHaveBeenCalledTimes(1);
  expect(jobs.getSnapshot('error')?.phase).toBe('done');
});

it('reports the configured failure and preserves it after the run ends', () => {
  const jobs = new MockRenderJobManager(100, true), events: RenderJobEvent[] = [];
  jobs.subscribe('project', event => events.push(event));jobs.start('project', options);
  vi.advanceTimersByTime(100);
  expect(events).toEqual([{ phase: 'failed', error: { code: 'render-failed', message: 'Mock render failure (SME_RENDER_MOCK_FAIL=1)' } }]);
  expect(jobs.getSnapshot('project')?.phase).toBe('failed');expect(jobs.activeCount()).toBe(0);
});

it('terminal observation cannot discard active work, and shutdown clears owned timers', () => {
  const jobs = new MockRenderJobManager(100), events: RenderJobEvent[] = [];
  let shutdownError = '';
  jobs.subscribe('a', event => {
    events.push(event);
    if(event.phase === 'cancelled') {
      try { jobs.start('c', options); } catch(error) { shutdownError = (error as Error).message; }
    }
  });
  jobs.start('discarded', options);jobs.discard('discarded');
  expect(jobs.exists('discarded')).toBe(true);jobs.cancel('discarded');
  jobs.start('a', options);jobs.start('b', options);jobs.killAll();
  expect(shutdownError).toBe('render-shutting-down');
  expect(jobs.activeCount()).toBe(0);expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(200);expect(events.map(event => event.phase)).toEqual(['cancelled']);
  jobs.start('a', options);vi.advanceTimersByTime(100);expect(events.at(-1)?.phase).toBe('done');
});

it('a reentrant cancellation is delivered after the in-flight progress event to every subscriber', () => {
  const jobs = new MockRenderJobManager(100), events: string[] = [];
  jobs.subscribe('project', event => { if (event.phase === 'rendering') jobs.cancel('project'); });
  jobs.subscribe('project', event => events.push(event.phase));
  jobs.start('project', options);vi.advanceTimersByTime(25);
  expect(events).toEqual(['rendering', 'cancelled']);
  expect(jobs.getSnapshot('project')?.phase).toBe('cancelled');
});

it('the old terminal-observation hook cannot erase a replacement started by another subscriber', () => {
  const jobs = new MockRenderJobManager(100);
  jobs.subscribe('project', event => { if(event.phase === 'done')jobs.start('project', { finalOutput: '/private/next.mp4' }); });
  jobs.subscribe('project', event => { if(event.phase === 'done')jobs.discard('project'); });
  jobs.start('project', options);vi.advanceTimersByTime(100);
  expect(jobs.getSnapshot('project')).toMatchObject({ phase: 'preparing', outputFile: 'next.mp4' });
  expect(jobs.activeCount()).toBe(1);
});

it('nested shutdown cannot release the outer shutdown guard', () => {
  const jobs = new MockRenderJobManager(100);let prevented = false;
  jobs.subscribe('project', event => {
    if(event.phase === 'cancelled') {
      jobs.killAll();
      try { jobs.start('replacement', options); } catch { prevented = true; }
    }
  });
  jobs.start('project', options);jobs.killAll();
  expect(prevented).toBe(true);expect(jobs.activeCount()).toBe(0);expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])('queued cancellation stays with its original subscriptions (reuse callback: %s)', reuse => {
  const jobs = new MockRenderJobManager(100), observed: string[] = [];let replaced = false;
  const listener = (event: RenderJobEvent) => observed.push(event.phase);
  let unsubscribe = () => {};
  jobs.subscribe('project', event => {
    if(event.phase === 'rendering' && !replaced) {
      replaced = true;jobs.cancel('project');jobs.start('project', { finalOutput: '/private/next.mp4' });
      unsubscribe();jobs.subscribe('project', listener);
    }
  });
  if(reuse)unsubscribe = jobs.subscribe('project', listener);
  jobs.start('project', options);vi.advanceTimersByTime(25);
  expect(jobs.getSnapshot('project')).toMatchObject({ phase: 'preparing', outputFile: 'next.mp4' });
  expect(observed).toEqual([]);
  vi.advanceTimersByTime(25);expect(observed).toEqual(['rendering']);
});

import { describe, it, expect } from 'vitest';
import {
  parseNormalizeEvent,
  nextNormalizeState,
  INITIAL_NORMALIZE_STATE,
  type NormalizeState,
} from './useNormalize';

describe('parseNormalizeEvent', () => {
  it('正常 JSON を parse、失敗は null', () => {
    expect(parseNormalizeEvent('{"type":"idle"}')).toEqual({ type: 'idle' });
    expect(parseNormalizeEvent('not json')).toBeNull();
  });
});

describe('nextNormalizeState', () => {
  it('snapshot(measuring) で running・phase=measuring', () => {
    const s = nextNormalizeState(INITIAL_NORMALIZE_STATE, { type: 'snapshot', job: { phase: 'measuring', startedAt: 1 } });
    expect(s.status).toBe('running');
    if (s.status === 'running') expect(s.phase).toBe('measuring');
  });
  it('done(done) で done・applied=true', () => {
    const s = nextNormalizeState(INITIAL_NORMALIZE_STATE, { type: 'done', phase: 'done' });
    expect(s).toEqual({ status: 'done', applied: true });
  });
  it('event(normalizing) は running の phase を更新する', () => {
    const running: NormalizeState = { status: 'running', phase: 'measuring', startedAt: 1, applied: false };
    const s = nextNormalizeState(running, { type: 'event', event: { phase: 'normalizing' } });
    expect(s.status).toBe('running');
    if (s.status === 'running') expect(s.phase).toBe('normalizing');
  });
  it('event(failed) で error、applied は維持', () => {
    const running: NormalizeState = { status: 'running', phase: 'measuring', startedAt: 1, applied: true };
    const s = nextNormalizeState(running, { type: 'event', event: { phase: 'failed', error: { code: 'x', message: 'm' } } });
    expect(s.status).toBe('error');
    expect(s.applied).toBe(true);
  });
});

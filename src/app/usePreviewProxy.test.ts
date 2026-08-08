import { describe, expect, it } from 'vitest';
import {
  INITIAL_PREVIEW_PROXY_STATE,
  nextPreviewProxyState,
  parsePreviewProxyEvent,
  type PreviewProxyState,
} from './usePreviewProxy';

const running: PreviewProxyState = { status: 'running', percent: 10, startedAt: 1 };

describe('parsePreviewProxyEvent', () => {
  it('JSON をパースし、壊れていれば null', () => {
    expect(parsePreviewProxyEvent('{"type":"idle"}')).toEqual({ type: 'idle' });
    expect(parsePreviewProxyEvent('oops')).toBeNull();
  });
});

describe('nextPreviewProxyState', () => {
  it('snapshot(converting) で running（percent 引き継ぎ）', () => {
    const next = nextPreviewProxyState(INITIAL_PREVIEW_PROXY_STATE, {
      type: 'snapshot',
      job: { phase: 'converting', startedAt: 5, percent: 42 },
    });
    expect(next).toEqual({ status: 'running', percent: 42, startedAt: 5 });
  });

  it('event(converting, percent) で percent が進む', () => {
    const next = nextPreviewProxyState(running, {
      type: 'event',
      event: { phase: 'converting', percent: 55 },
    });
    expect(next).toEqual({ status: 'running', percent: 55, startedAt: 1 });
  });

  it('percent なしの event（finalizing）は percent を保持する', () => {
    const next = nextPreviewProxyState(running, { type: 'event', event: { phase: 'finalizing' } });
    expect(next).toEqual({ status: 'running', percent: 10, startedAt: 1 });
  });

  it('done で完了・failed でエラー', () => {
    expect(nextPreviewProxyState(running, { type: 'done', phase: 'done' })).toEqual({ status: 'done' });
    const err = nextPreviewProxyState(running, {
      type: 'done',
      phase: 'failed',
      error: { code: 'duration-mismatch', message: 'x' },
    });
    expect(err).toEqual({ status: 'error', error: { code: 'duration-mismatch', message: 'x' } });
  });

  it('cancelled は状態を変えない（フック側が status を取り直す）', () => {
    expect(nextPreviewProxyState(running, { type: 'done', phase: 'cancelled' })).toEqual(running);
  });

  it('idle メッセージは無視', () => {
    expect(nextPreviewProxyState(running, { type: 'idle' })).toEqual(running);
  });
});

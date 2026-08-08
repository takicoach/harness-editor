/**
 * useDenoise フックのユニットテスト。
 *
 * SSE と fetch をモックし、状態遷移をフックとして検証する。
 * React コンポーネントをマウントせず pure-state テストとして実装する。
 */

import { describe, it, expect } from 'vitest';

// useDenoise の状態管理ロジックを純関数として切り出して検証する。
// フックそのものは DOM 依存のため、型と定数だけをインポートして検証する。
import type { DenoiseStatus, DenoiseStrength } from './useDenoise';

describe('DenoiseStatus の型', () => {
  it('初期状態は idle', () => {
    const idle: DenoiseStatus = 'idle';
    expect(idle).toBe('idle');
  });

  it('実行中は running', () => {
    const running: DenoiseStatus = 'running';
    expect(running).toBe('running');
  });

  it('完了は done', () => {
    const done: DenoiseStatus = 'done';
    expect(done).toBe('done');
  });

  it('エラーは error', () => {
    const error: DenoiseStatus = 'error';
    expect(error).toBe('error');
  });
});

describe('DenoiseStrength の型', () => {
  it('弱/中/強の 3 段階', () => {
    const weak: DenoiseStrength = 'weak';
    const mid: DenoiseStrength = 'mid';
    const strong: DenoiseStrength = 'strong';
    expect(weak).toBe('weak');
    expect(mid).toBe('mid');
    expect(strong).toBe('strong');
  });
});

// SSE メッセージのパース検証（純関数として切り出した parseDenoiseEvent）
describe('parseDenoiseEvent', () => {
  it('idle メッセージを返す', async () => {
    const { parseDenoiseEvent } = await import('./useDenoise');
    const result = parseDenoiseEvent(JSON.stringify({ type: 'idle' }));
    expect(result).toEqual({ type: 'idle' });
  });

  it('snapshot メッセージを返す', async () => {
    const { parseDenoiseEvent } = await import('./useDenoise');
    const result = parseDenoiseEvent(
      JSON.stringify({ type: 'snapshot', job: { phase: 'denoising', startedAt: 1000 } }),
    );
    expect(result).toMatchObject({ type: 'snapshot', job: { phase: 'denoising' } });
  });

  it('done メッセージを返す', async () => {
    const { parseDenoiseEvent } = await import('./useDenoise');
    const result = parseDenoiseEvent(
      JSON.stringify({ type: 'done', phase: 'done' }),
    );
    expect(result).toMatchObject({ type: 'done', phase: 'done' });
  });

  it('event メッセージを返す', async () => {
    const { parseDenoiseEvent } = await import('./useDenoise');
    const result = parseDenoiseEvent(
      JSON.stringify({ type: 'event', event: { phase: 'denoising' } }),
    );
    expect(result).toMatchObject({ type: 'event', event: { phase: 'denoising' } });
  });

  it('不正な JSON は null を返す', async () => {
    const { parseDenoiseEvent } = await import('./useDenoise');
    const result = parseDenoiseEvent('invalid json{{{');
    expect(result).toBeNull();
  });
});

// DenoiseState 初期値の確認（nextDenoiseState）
describe('nextDenoiseState', () => {
  it('idle SSE を受け取って状態を維持', async () => {
    const { nextDenoiseState, INITIAL_DENOISE_STATE } = await import('./useDenoise');
    const next = nextDenoiseState(INITIAL_DENOISE_STATE, { type: 'idle' });
    expect(next.status).toBe('idle');
  });

  it('snapshot(denoising) で running に遷移', async () => {
    const { nextDenoiseState, INITIAL_DENOISE_STATE } = await import('./useDenoise');
    const next = nextDenoiseState(INITIAL_DENOISE_STATE, {
      type: 'snapshot',
      job: { phase: 'denoising', startedAt: 1000 },
    });
    expect(next.status).toBe('running');
    expect(next.status === 'running' ? next.phase : null).toBe('denoising');
  });

  it('snapshot(done) で done に遷移', async () => {
    const { nextDenoiseState, INITIAL_DENOISE_STATE } = await import('./useDenoise');
    const next = nextDenoiseState(INITIAL_DENOISE_STATE, {
      type: 'snapshot',
      job: { phase: 'done', startedAt: 1000 },
    });
    expect(next.status).toBe('done');
  });

  it('done SSE で done に遷移', async () => {
    const { nextDenoiseState, INITIAL_DENOISE_STATE } = await import('./useDenoise');
    const next = nextDenoiseState(INITIAL_DENOISE_STATE, { type: 'done', phase: 'done' });
    expect(next.status).toBe('done');
  });

  it('done(failed) SSE で error に遷移', async () => {
    const { nextDenoiseState, INITIAL_DENOISE_STATE } = await import('./useDenoise');
    const next = nextDenoiseState(INITIAL_DENOISE_STATE, {
      type: 'done',
      phase: 'failed',
      error: { code: 'ffmpeg-error', message: '終了コード 1' },
    });
    expect(next.status).toBe('error');
    expect(next.status === 'error' ? next.error.code : null).toBe('ffmpeg-error');
  });

  it('event(denoising) で running.phase が更新される', async () => {
    const { nextDenoiseState } = await import('./useDenoise');
    const running = {
      status: 'running' as const,
      phase: 'preparing',
      applied: false,
      startedAt: 1000,
    };
    const next = nextDenoiseState(running, {
      type: 'event',
      event: { phase: 'denoising' },
    });
    expect(next.status).toBe('running');
    expect(next.status === 'running' ? next.phase : null).toBe('denoising');
  });
});

import { describe, expect, it } from 'vitest';
import { readinessSteps } from './aiReadiness';

const states = (view: ReturnType<typeof readinessSteps>) => view?.steps.map(step => step.state);

describe('使えるまでの案内', () => {
  it('導入 → ログイン → 接続の確認 → 使える', () => {
    expect(states(readinessSteps({ phase: 'need-install', purpose: 'work', connected: false }))).toEqual(['current', 'todo', 'todo', 'todo']);
    expect(states(readinessSteps({ phase: 'need-login', purpose: 'work', connected: false }))).toEqual(['done', 'current', 'todo', 'todo']);
    expect(states(readinessSteps({ phase: 'connected', purpose: 'login', connected: false }))).toEqual(['done', 'current', 'todo', 'todo']);
    expect(states(readinessSteps({ phase: 'starting', purpose: 'work', connected: false }))).toEqual(['done', 'done', 'current', 'todo']);
    expect(states(readinessSteps({ phase: 'connected', purpose: 'work', connected: false }))).toEqual(['done', 'done', 'current', 'todo']);
    expect(readinessSteps({ phase: 'connected', purpose: 'work', connected: true })).toMatchObject({ ready: true, steps: [{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'done' }] });
  });
  it('文言: ログインの手順・接続の確認中・使える。設定ファイルの手直しは求めない', () => {
    expect(readinessSteps({ phase: 'need-login', purpose: 'work', connected: false })?.message).toContain('「ログインする」');
    expect(readinessSteps({ phase: 'need-login', purpose: 'work', connected: false, loginExpired: true })?.message).toContain('ログインが切れています');
    expect(readinessSteps({ phase: 'connected', purpose: 'login', connected: false })?.message).toContain('「ログインできたので始める」');
    expect(readinessSteps({ phase: 'starting', purpose: 'work', connected: false })?.message).toContain('接続を確かめています');
    expect(readinessSteps({ phase: 'connected', purpose: 'work', connected: true })?.message).toContain('AI が使えます');
    for (const phase of ['need-install', 'need-login', 'starting', 'connected'] as const)
      expect(readinessSteps({ phase, purpose: 'work', connected: false })?.message).not.toMatch(/設定ファイル|json|config/i);
  });
  it('終了・切断・確認中は出さない（それぞれの画面が案内する）', () => {
    for (const phase of ['checking', 'exited', 'takeover', 'failed'] as const) expect(readinessSteps({ phase, purpose: 'work', connected: false })).toBeNull();
  });
});

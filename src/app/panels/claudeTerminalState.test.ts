import { describe, it, expect } from 'vitest';
import { nextTerminalPhase, type Phase } from './claudeTerminalState';

describe('nextTerminalPhase', () => {
  const cases: Array<[Phase, Parameters<typeof nextTerminalPhase>[1], Phase]> = [
    ['checking', { type: 'status', installed: true }, 'starting'],
    ['checking', { type: 'status', installed: false }, 'need-install'],
    ['need-install', { type: 'install-start' }, 'installing'],
    ['installing', { type: 'install-status', phase: 'done' }, 'starting'],
    ['installing', { type: 'install-status', phase: 'failed' }, 'install-failed'],
    ['installing', { type: 'install-status', phase: 'running' }, 'installing'],
    ['starting', { type: 'ws-auth-ok' }, 'connected'],
    ['connected', { type: 'ws-exit', code: 0 }, 'exited'],
    ['connected', { type: 'ws-takeover' }, 'takeover'],
    ['exited', { type: 'restart' }, 'starting'],
    ['install-failed', { type: 'install-start' }, 'installing'],
    ['starting', { type: 'fail', message: 'AI への接続に失敗しました' }, 'failed'],
    ['connected', { type: 'fail', message: 'AI への接続に失敗しました' }, 'failed'],
    ['failed', { type: 'restart' }, 'starting'],
    ['checking', { type: 'fail', message: 'AI への接続に失敗しました' }, 'checking'],
  ];
  for (const [from, ev, to] of cases) {
    it(`${from} + ${ev.type} → ${to}`, () => {
      expect(nextTerminalPhase(from, ev)).toBe(to);
    });
  }
  it('未知の組み合わせは現状維持', () => {
    expect(nextTerminalPhase('connected', { type: 'install-start' })).toBe('connected');
  });

  it('connected からの restart（ツール切替）で starting に戻る', () => {
    expect(nextTerminalPhase('connected', { type: 'restart' })).toBe('starting');
  });
});

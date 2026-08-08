/** AiTerminal の表示フェーズ状態機械（純関数・DOM 非依存）。 */
export type Phase =
  | 'checking' | 'need-install' | 'installing' | 'install-failed'
  | 'starting' | 'connected' | 'exited' | 'takeover' | 'failed';

export type TermEvent =
  | { type: 'status'; installed: boolean }
  | { type: 'install-start' }
  | { type: 'install-status'; phase: 'idle' | 'running' | 'done' | 'failed' }
  | { type: 'ws-auth-ok' }
  | { type: 'ws-exit'; code: number }
  | { type: 'ws-takeover' }
  | { type: 'restart' }
  | { type: 'fail'; message: string };

export function nextTerminalPhase(current: Phase, ev: TermEvent): Phase {
  switch (ev.type) {
    case 'status':
      return current === 'checking' ? (ev.installed ? 'starting' : 'need-install') : current;
    case 'install-start':
      return current === 'need-install' || current === 'install-failed' ? 'installing' : current;
    case 'install-status':
      if (current !== 'installing') return current;
      if (ev.phase === 'done') return 'starting';
      if (ev.phase === 'failed') return 'install-failed';
      return 'installing';
    case 'ws-auth-ok':
      return current === 'starting' ? 'connected' : current;
    case 'ws-exit':
      return current === 'connected' ? 'exited' : current;
    case 'ws-takeover':
      return current === 'connected' ? 'takeover' : current;
    case 'restart':
      // 'connected' からも 'starting' へ行けるのは、ツール切替（switchTool 成功後）が
      // 接続中の端末を明示的に再起動させる経路のため（通常の exited/takeover/failed
      // からの再起動と同じ扱いでよい）。
      return current === 'exited' || current === 'takeover' || current === 'failed' ||
        current === 'connected'
        ? 'starting'
        : current;
    case 'fail':
      return current === 'starting' || current === 'connected' ? 'failed' : current;
  }
}

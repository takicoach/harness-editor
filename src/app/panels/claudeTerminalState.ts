/** AiTerminal の表示フェーズ状態機械（純関数・DOM 非依存）。 */
import type { AiLoginState } from '../../shared/aiFocus';

export type Phase =
  | 'checking' | 'need-install' | 'installing' | 'install-failed' | 'need-login'
  | 'starting' | 'connected' | 'exited' | 'takeover' | 'failed';

export type TermEvent =
  | { type: 'status'; installed: boolean; login?: AiLoginState }
  | { type: 'install-start' }
  | { type: 'install-status'; phase: 'idle' | 'running' | 'done' | 'failed' }
  | { type: 'login-open' }
  | { type: 'ws-auth-ok' }
  | { type: 'ws-exit'; code: number; reason?: 'auth' | null }
  | { type: 'ws-takeover' }
  | { type: 'restart' }
  | { type: 'fail'; message: string };

export function nextTerminalPhase(current: Phase, ev: TermEvent): Phase {
  switch (ev.type) {
    case 'status':
      // 未ログインと分かった時だけ止める（unknown は確かめられないので起動する）。
      return current === 'checking' ? (!ev.installed ? 'need-install' : ev.login === 'missing' ? 'need-login' : 'starting') : current;
    case 'install-start':
      return current === 'need-install' || current === 'install-failed' ? 'installing' : current;
    case 'install-status':
      if (current !== 'installing') return current;
      // 導入が終わったら、ログインを確かめ直す（導入直後は未ログインのことが多い）。
      if (ev.phase === 'done') return 'checking';
      if (ev.phase === 'failed') return 'install-failed';
      return 'installing';
    case 'login-open':
      // ログインのための起動（最初の依頼は渡さない）。
      return current === 'need-login' ? 'starting' : current;
    case 'ws-auth-ok':
      return current === 'starting' ? 'connected' : current;
    case 'ws-exit':
      // ログインが切れて終わった時は、再起動ではなくログインを案内する（再起動しても同じ理由で終わる）。
      return current === 'connected' ? (ev.reason === 'auth' ? 'need-login' : 'exited') : current;
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

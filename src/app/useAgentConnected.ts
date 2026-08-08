import { useEffect, useState } from 'react';

/** /api/agent-status の応答（?id= 付き指定時は dedicated も含む）。 */
interface AgentStatusResponse {
  connected: boolean;
  dedicated?: { connected: boolean };
}

/** useAgentConnected の戻り値。 */
export interface AgentConnectedState {
  /** 全体待機（グローバル・フィルタなし takeOrWait）の在席。null = まだ不明（初回応答前）。 */
  global: boolean | null;
  /** この動画の専属在席。projectId 未指定時は常に null（判定不能）。 */
  dedicated: boolean | null;
}

const AGENT_POLL_MS = 4000;

/**
 * AI エージェント（MCP 消費者）の接続状態をポーリングで追う。
 * projectId を渡すとその動画の専属在席（dedicated）も取得する（未指定時は dedicated: null）。
 * AI タブとチュートリアルの MCP ステップが使う。
 */
export function useAgentConnected(active: boolean, projectId?: string): AgentConnectedState {
  const [state, setState] = useState<AgentConnectedState>({ global: null, dedicated: null });
  useEffect(() => {
    if (!active) return;
    let alive = true;
    async function check(): Promise<void> {
      try {
        const url =
          projectId !== undefined ? `/api/agent-status?id=${encodeURIComponent(projectId)}` : '/api/agent-status';
        const res = await fetch(url);
        if (!res.ok) return;
        const body = (await res.json()) as AgentStatusResponse;
        if (alive) {
          setState({
            global: body.connected === true,
            dedicated: projectId !== undefined ? body.dedicated?.connected === true : null,
          });
        }
      } catch {
        // 応答が無くても表示は前回値を維持（サーバ再起動中など）。
      }
    }
    void check();
    const timer = setInterval(() => void check(), AGENT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active, projectId]);
  return state;
}

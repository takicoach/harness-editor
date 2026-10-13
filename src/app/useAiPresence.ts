import { useEffect, useState } from 'react';
import type { AiPresence } from '../shared/aiFocus';

/** 在席の取り直しの間隔。 */
export const AI_PRESENCE_POLL_MS = 3000;
/** 「AI が使えるか」（端末が起動していて MCP の接続が生きている）と主画面の台帳。取れない間は前の値のまま。 */
export function useAiPresence(active: boolean): AiPresence | null {
  const [presence, setPresence] = useState<AiPresence | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const check = async () => {
      try {
        const response = await fetch('/api/ai/presence');
        if (response.ok && alive) setPresence(await response.json() as AiPresence);
      } catch { /* サーバの再起動中などは前の値を出し続ける */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), AI_PRESENCE_POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [active]);
  return presence;
}

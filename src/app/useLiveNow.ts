import { useEffect, useState } from 'react';

/**
 * 現在時刻（ms）を保持し、intervalMs ごとに更新して再レンダーを起こすフック。
 * 相対時刻表示（「2時間前」等）・stale 判定がホーム画面表示中に自動で進行するために使う。
 * unmount 時に interval をクリアする。
 */
export function useLiveNow(intervalMs = 45_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

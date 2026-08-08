import { useCallback, useEffect, useState } from 'react';

/** 開いているプロジェクトの「古いパック」一覧を取得し、更新を実行するフック。 */
export function usePackStatus(selectedId: string | null) {
  const [stalePacks, setStalePacks] = useState<string[]>([]);

  const refetch = useCallback(async () => {
    if (selectedId === null) {
      setStalePacks([]);
      return;
    }
    try {
      const res = await fetch(`/api/pack-status?id=${encodeURIComponent(selectedId)}`);
      if (!res.ok) {
        setStalePacks([]);
        return;
      }
      const body = (await res.json()) as { stale?: string[] };
      setStalePacks(Array.isArray(body.stale) ? body.stale : []);
    } catch {
      setStalePacks([]);
    }
  }, [selectedId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const upgrade = useCallback(async (): Promise<boolean> => {
    if (selectedId === null) return false;
    try {
      const res = await fetch(`/api/pack-upgrade?id=${encodeURIComponent(selectedId)}`, { method: 'POST' });
      return res.ok;
    } catch {
      return false;
    }
  }, [selectedId]);

  return { stalePacks, refetch, upgrade };
}

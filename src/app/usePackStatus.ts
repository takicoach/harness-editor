import { useCallback, useEffect, useState } from 'react';

/** 更新の前に出す説明。`gainingCount` は数えられない案件では null（推定しない）。 */
export interface PackUpgradeNotice {
  id: string;
  note: string;
  gainingCount: number | null;
}

/** 開いているプロジェクトの「古いパック」一覧を取得し、更新・更新前への復元を実行するフック。 */
export function usePackStatus(selectedId: string | null) {
  const [stalePacks, setStalePacks] = useState<string[]>([]);
  const [notices, setNotices] = useState<PackUpgradeNotice[]>([]);
  const [revertable, setRevertable] = useState(false);

  const refetch = useCallback(async () => {
    const clear = () => {
      setStalePacks([]);
      setNotices([]);
      setRevertable(false);
    };
    if (selectedId === null) {
      clear();
      return;
    }
    try {
      const res = await fetch(`/api/pack-status?id=${encodeURIComponent(selectedId)}`);
      if (!res.ok) {
        clear();
        return;
      }
      const body = (await res.json()) as { stale?: string[]; notices?: PackUpgradeNotice[]; revertable?: boolean };
      setStalePacks(Array.isArray(body.stale) ? body.stale : []);
      setNotices(Array.isArray(body.notices) ? body.notices : []);
      // 不明なら出さない（推定しない）。false 初期値だと更新前に「戻す」が出る（事前検査 B の B10-2）。
      setRevertable(body.revertable === true);
    } catch {
      clear();
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

  const revert = useCallback(async (): Promise<boolean> => {
    if (selectedId === null) return false;
    try {
      const res = await fetch(`/api/pack-revert?id=${encodeURIComponent(selectedId)}`, { method: 'POST' });
      return res.ok;
    } catch {
      return false;
    }
  }, [selectedId]);

  return { stalePacks, notices, revertable, refetch, upgrade, revert };
}

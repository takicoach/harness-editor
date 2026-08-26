import { useCallback, useEffect, useState } from 'react';
import {
  listTrashRequest,
  restoreTrashRequest,
  emptyTrashRequest,
  type LibrariesPatch,
  type TrashEntry,
} from '../trashApi';
import { TrashConfirmDialog } from './TrashConfirmDialog';

export interface TrashDialogProps {
  /** プロジェクトID（素材のゴミ箱）。null ならルート（プロジェクトのゴミ箱）。 */
  projectId: string | null;
  onClose: () => void;
  /**
   * 復元・完全削除の後に呼ぶ。素材ゴミ箱ではサーバが返した素材ライブラリのパッチを渡す
   * （呼び出し側は全体 reload ではなく部分反映する＝編集中の未保存状態を捨てない）。
   * ルートのゴミ箱やパッチを取れなかった場合は null。
   */
  onChanged: (libraries: LibrariesPatch | null) => void;
}

/** ゴミ箱一覧（復元・完全削除）。ExportDialog のオーバーレイ構造を踏襲。 */
export function TrashDialog({ projectId, onClose, onChanged }: TrashDialogProps) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 完全削除の確認対象（entryId。'*' は「ゴミ箱を空にする」）。
  const [purgeTarget, setPurgeTarget] = useState<{ id: string; name: string } | null>(null);
  // 復元・完全削除の送信中。連打による二重送信を止める。
  const [pending, setPending] = useState(false);

  const refresh = useCallback(() => {
    // 前回の失敗表示を持ち越さない（再取得できたのに赤いエラーが残る状態を作らない）。
    setError(null);
    listTrashRequest(projectId)
      .then(setEntries)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'ゴミ箱を読み込めませんでした'),
      );
  }, [projectId]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = (fn: () => Promise<{ libraries: LibrariesPatch | null }>): void => {
    if (pending) return;
    setPending(true);
    void fn()
      .then((r) => {
        setError(null);
        refresh();
        onChanged(r.libraries);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '操作に失敗しました'))
      .finally(() => setPending(false));
  };

  return (
    <div className="export-overlay" onClick={onClose}>
      <div
        className="export-dialog trash-dialog"
        role="dialog"
        aria-label="ゴミ箱"
        data-testid="trash-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="export-head">ゴミ箱</div>
        {error !== null && <p className="sme-error">{error}</p>}
        {entries !== null && entries.length === 0 && <p className="trash-none">ゴミ箱は空です</p>}
        {entries !== null && entries.length > 0 && (
          <ul className="trash-list">
            {entries.map((e) => (
              <li key={e.id} className="trash-item" data-entry-id={e.id}>
                <span className="trash-name" title={e.originalPath}>{e.name}</span>
                <span className="trash-date">
                  {new Date(e.deletedAt).toLocaleString('ja-JP')}
                </span>
                <button
                  type="button"
                  className="trash-restore"
                  disabled={pending}
                  onClick={() => act(() => restoreTrashRequest(projectId, e.id))}
                >
                  復元
                </button>
                <button
                  type="button"
                  className="trash-purge"
                  disabled={pending}
                  onClick={() => setPurgeTarget({ id: e.id, name: e.name })}
                >
                  完全削除
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="export-actions">
          {entries !== null && entries.length > 0 && (
            <button
              type="button"
              className="trash-empty-all"
              disabled={pending}
              onClick={() => setPurgeTarget({ id: '*', name: 'ゴミ箱の中身すべて' })}
            >
              ゴミ箱を空にする
            </button>
          )}
          <button type="button" className="export-cancel" onClick={onClose}>
            閉じる
          </button>
        </div>
        {purgeTarget !== null && (
          <TrashConfirmDialog
            name={purgeTarget.name}
            usedCount={0}
            mode="purge"
            busy={pending}
            onConfirm={() => {
              const t = purgeTarget;
              setPurgeTarget(null);
              act(() => emptyTrashRequest(projectId, t.id === '*' ? undefined : t.id));
            }}
            onCancel={() => setPurgeTarget(null)}
          />
        )}
      </div>
    </div>
  );
}

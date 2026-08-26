import { useCallback, useEffect, useState } from 'react';
import { listTrashRequest, restoreTrashRequest, emptyTrashRequest, type TrashEntry } from '../trashApi';
import { TrashConfirmDialog } from './TrashConfirmDialog';
import { VideoThumb } from './VideoThumb';

export interface TrashViewProps {
  /** ホーム（一覧／進行ボード）へ戻る。 */
  onBack: () => void;
  /** 復元・完全削除のあとにプロジェクト一覧を取り直す（App の refreshProjects）。 */
  onChanged: () => void;
}

/**
 * ルート（プロジェクト）のゴミ箱ビュー。ホームの一覧・進行ボードと同じ画面領域を使い、
 * 同じ `.home-card` の意匠でカード表示する（旧: 小さな TrashDialog）。
 * 素材のゴミ箱（エディタ内）は従来どおり `TrashDialog` のまま。
 */
export function TrashView({ onBack, onChanged }: TrashViewProps) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 完全削除の確認対象（'*' は「ゴミ箱を空にする」）。
  const [purgeTarget, setPurgeTarget] = useState<{ id: string; name: string } | null>(null);
  // 復元・完全削除の送信中。連打による二重送信を止める。
  const [pending, setPending] = useState(false);

  const refresh = useCallback(() => {
    // 前回の失敗表示を持ち越さない（再取得できたのに赤いエラーが残る状態を作らない）。
    setError(null);
    listTrashRequest(null)
      .then(setEntries)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'ゴミ箱を読み込めませんでした'));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = (fn: () => Promise<unknown>): void => {
    if (pending) return;
    setPending(true);
    void fn()
      .then(() => {
        setError(null);
        refresh();
        onChanged();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '操作に失敗しました'))
      .finally(() => setPending(false));
  };

  const count = entries?.length ?? 0;

  return (
    <div className="home trash-view" data-testid="trash-view">
      <div className="home-head">
        <h1>ゴミ箱</h1>
        <span className="home-count">{count} 件</span>
        <div className="trash-view-actions">
          {count > 0 && (
            <button
              type="button"
              className="trash-empty-all"
              disabled={pending}
              onClick={() => setPurgeTarget({ id: '*', name: 'ゴミ箱の中身すべて' })}
            >
              ゴミ箱を空にする
            </button>
          )}
          <button type="button" className="home-trash-back" onClick={onBack}>
            戻る
          </button>
        </div>
      </div>
      {error !== null && <p className="sme-error" role="alert">{error}</p>}
      {entries !== null && entries.length === 0 && (
        <div className="sme-center">
          <p className="trash-none">ゴミ箱は空です</p>
          <p className="hint">削除したプロジェクトはここに入り、いつでも元に戻せます</p>
        </div>
      )}
      {entries !== null && entries.length > 0 && (
        <div className="home-grid">
          {entries.map((e) => (
            <div key={e.id} className="home-card trash-card" data-testid="trash-card" data-entry-id={e.id}>
              {/*
                サムネイルはホームカードと同じ機構（VideoThumb・`.home-card-thumb`）。
                違うのは配信先だけで、tombstone 内の動画は GET /api/trash/video が返す。
                **送るのは entryId だけ**（実パスはサーバが manifest から導出する）。
                向きは記録していないので 16:9 枠にレターボックス（`v`＝contain）で収める。
                動画なし・リンク切れ・非対応形式は fallback でホームと同じ空サムネへ落ち、
                一覧・復元・完全削除には影響しない。
              */}
              <div className="home-card-thumb v">
                {e.kind === 'project' ? (
                  <VideoThumb
                    src={`/api/trash/video?entryId=${encodeURIComponent(e.id)}`}
                    fallback={<div className="home-card-thumb-empty" />}
                  />
                ) : (
                  <div className="home-card-thumb-empty" />
                )}
              </div>
              <div className="home-card-body">
                <div className="home-card-name" title={e.name}>{e.name}</div>
                <div className="home-card-meta">
                  <span>削除: {formatDeletedAt(e.deletedAt)}</span>
                </div>
                <div className="trash-card-path" title={e.originalPath}>
                  元の保存先: {e.originalPath}
                </div>
                <div className="trash-card-actions">
                  <button
                    type="button"
                    className="trash-restore"
                    disabled={pending}
                    onClick={() => act(() => restoreTrashRequest(null, e.id))}
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
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {purgeTarget !== null && (
        <TrashConfirmDialog
          name={purgeTarget.name}
          usedCount={0}
          mode="purge"
          busy={pending}
          onConfirm={() => {
            const t = purgeTarget;
            setPurgeTarget(null);
            act(() => emptyTrashRequest(null, t.id === '*' ? undefined : t.id));
          }}
          onCancel={() => setPurgeTarget(null)}
        />
      )}
    </div>
  );
}

/** 削除日時の表示。解釈できない値はそのまま出す（一覧を落とさない）。 */
function formatDeletedAt(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString('ja-JP');
}

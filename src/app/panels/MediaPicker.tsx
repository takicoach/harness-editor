import { useCallback, useEffect, useState } from 'react';
import { browseFolder, type BrowseListing } from '../browseApi';
import { formatSize } from '../../shared/format';

interface MediaPickerProps {
  /** ダイアログの見出し。 */
  title: string;
  /** 補足説明（1 行）。 */
  note?: string;
  /** 動画を選んだ。path は絶対パス。 */
  onPick: (file: { name: string; path: string; sizeBytes: number }) => void;
  onCancel: () => void;
}

/**
 * 外付けストレージ等から動画を選ぶための簡易ファイラ（新規作成のリンク取り込み・再リンク用）。
 *
 * ブラウザの file input は選んだファイルの絶対パスを渡さないため、サーバ側の
 * `/api/browse` を叩いて一覧する。走査できるのはサーバが許可した起点の配下だけ。
 * （サイドバーの `FolderBrowser` はプロジェクト一覧で、別物。）
 */
export function MediaPicker({ title, note, onPick, onCancel }: MediaPickerProps) {
  const [listing, setListing] = useState<BrowseListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback((path?: string) => {
    setLoading(true);
    setError(null);
    browseFolder(path)
      .then((res) => setListing(res))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'フォルダを開けませんでした'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="export-overlay" onClick={onCancel}>
      <div className="export-dialog mp-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-head">{title}</div>
        {note !== undefined && <p className="mp-note">{note}</p>}

        <div className="mp-roots" role="group" aria-label="場所">
          {(listing?.roots ?? []).map((r) => (
            <button
              key={r.key}
              type="button"
              className={'mp-root' + (listing?.path?.startsWith(r.path) === true ? ' on' : '')}
              onClick={() => load(r.path)}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="mp-path" title={listing?.path ?? ''}>
          {listing?.path ?? '上の場所から選んでください'}
        </div>

        <div className="mp-list">
          {loading && <div className="mp-empty">読み込み中…</div>}
          {!loading && error !== null && <p className="sme-error mp-error">{error}</p>}
          {!loading && error === null && listing !== null && (
            <>
              {listing.parent !== null && (
                <button type="button" className="mp-row mp-up" onClick={() => load(listing.parent ?? undefined)}>
                  <span className="mp-icon" aria-hidden="true">↩</span>
                  <span className="mp-name">上のフォルダへ</span>
                </button>
              )}
              {listing.dirs.map((d) => (
                <button key={d.path} type="button" className="mp-row mp-dir" onClick={() => load(d.path)}>
                  <span className="mp-icon" aria-hidden="true">📁</span>
                  <span className="mp-name">{d.name}</span>
                </button>
              ))}
              {listing.files.map((f) => (
                <button key={f.path} type="button" className="mp-row mp-file" onClick={() => onPick(f)}>
                  <span className="mp-icon" aria-hidden="true">🎬</span>
                  <span className="mp-name">{f.name}</span>
                  <span className="mp-size">{formatSize(f.sizeBytes)}</span>
                </button>
              ))}
              {listing.path !== null && listing.dirs.length === 0 && listing.files.length === 0 && (
                <div className="mp-empty">このフォルダに動画はありません</div>
              )}
              {listing.path === null && listing.roots.length === 0 && (
                <div className="mp-empty">選べる場所がありません（外付けを接続してください）</div>
              )}
              {listing.truncated && (
                <div className="mp-empty">項目が多いため一部だけ表示しています</div>
              )}
            </>
          )}
        </div>

        <div className="export-actions">
          <button type="button" className="export-cancel" onClick={onCancel}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}

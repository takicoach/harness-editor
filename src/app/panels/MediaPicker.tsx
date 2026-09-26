import { useCallback, useEffect, useRef, useState } from 'react';
import { browseFolder, type BrowseListing } from '../browseApi';
import { formatSize } from '../../shared/format';
import {TaskProgress} from '../components/TaskProgress';
import { createMediaKind } from '../../shared/createMedia';

export interface PickedFile { name: string; path: string; sizeBytes: number }
interface MediaPickerProps {
  /** ダイアログの見出し。 */
  title: string;
  /** 補足説明（1 行）。 */
  note?: string;
  media?:'all';
  /**
   * 画像を複数選べるようにする（新規作成・設計 M6b）。画像の行は押すたびに選択を切り替え、選んだ順に番号を出す。
   * 動画・音声の行は従来どおり押した1件をすぐ選ぶ。
   */
  multiple?: boolean;
  /** 素材を1件選んだ。path は絶対パス。 */
  onPick: (file: PickedFile) => void;
  /** 画像を2枚以上選んで「選んだ画像で作成」を押した（選んだ順）。multiple のときだけ使う。 */
  onPickMany?: (files: PickedFile[]) => void;
  onCancel: () => void;
}
const fileIcon = (name: string): string => ({ audio: '🎵', image: '🖼' } as Record<string, string>)[createMediaKind(name) ?? ''] ?? '🎬';

/**
 * 外付けストレージ等から動画を選ぶための簡易ファイラ（新規作成のリンク取り込み・再リンク用）。
 *
 * ブラウザの file input は選んだファイルの絶対パスを渡さないため、サーバ側の
 * `/api/browse` を叩いて一覧する。走査できるのはサーバが許可した起点の配下だけ。
 * （サイドバーの `FolderBrowser` はプロジェクト一覧で、別物。）
 */
export function MediaPicker({ title, note, onPick, onCancel,media,multiple=false,onPickMany }: MediaPickerProps) {
  const [listing, setListing] = useState<BrowseListing | null>(null);
  const [chosen, setChosen] = useState<PickedFile[]>([]);
  const toggle = (file: PickedFile) => setChosen((current) => current.some((item) => item.path === file.path)
    ? current.filter((item) => item.path !== file.path) : [...current, file]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /**
   * 発行済みリクエストの通し番号。**どの応答が新しいかを到着順で推測しない**ための番号で、
   * J-0（一覧更新とライブ差分）の statusSeq、isCurrent(id)、sessionSeed と同じ考え方。
   *
   * 走査 GET は同時に複数飛ぶ: 本体は React.StrictMode（src/app/main.tsx）配下なので
   * マウント時の effect が 2 回走って起点一覧の GET が 2 本出るし、起点タブの連打でも増える。
   * 到着順で setListing すると、遅れて着地した**古い**起点一覧が、その後に選んだフォルダの
   * 一覧を上書きしうる。その状態（path=null・roots あり）は「読み込み中」でも「動画なし」でも
   * 「場所なし」でもないため画面には何も出ず、次のイベントも来ないので永久に固まる
   * （実測: フルスイート e2e `create-project.spec.ts:122` が `.mp-file` を 60s 待って赤）。
   */
  const issued = useRef(0);

  const load = useCallback((path?: string) => {
    const mine = ++issued.current;
    /** この応答が今も最新の要求か（自分より後の要求が出ていたら着地は捨てる）。 */
    const isLatest = (): boolean => issued.current === mine;
    setLoading(true);
    setError(null);
    (media?browseFolder(path,media):browseFolder(path))
      .then((res) => { if (isLatest()) setListing(res); })
      .catch((err: unknown) => {
        if (isLatest()) setError(err instanceof Error ? err.message : 'フォルダを開けませんでした');
      })
      .finally(() => { if (isLatest()) setLoading(false); });
  }, [media]);

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
          {loading && <div className="mp-empty"><TaskProgress compact label="素材の一覧を読み込んでいます"/></div>}
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
              {listing.files.map((f) => {
                const selectable = multiple && createMediaKind(f.name) === 'image', order = chosen.findIndex((item) => item.path === f.path);
                return (
                  <button key={f.path} type="button" className={'mp-row mp-file' + (order >= 0 ? ' mp-selected' : '')}
                    aria-pressed={selectable ? order >= 0 : undefined} onClick={() => (selectable ? toggle(f) : onPick(f))}>
                    <span className="mp-icon" aria-hidden="true">{fileIcon(f.name)}</span>
                    <span className="mp-name">{f.name}</span>
                    {order >= 0 && <span className="mp-order" aria-label={`${order + 1} 番目`}>{order + 1}</span>}
                    <span className="mp-size">{formatSize(f.sizeBytes)}</span>
                  </button>
                );
              })}
              {listing.path !== null && listing.dirs.length === 0 && listing.files.length === 0 && (
                <div className="mp-empty">このフォルダに{media==='all'?'素材':'動画'}はありません</div>
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
          {multiple && chosen.length > 0 && (
            <button type="button" className="export-start" data-testid="mp-confirm"
              onClick={() => (chosen.length === 1 ? onPick(chosen[0]!) : onPickMany?.(chosen))}>
              選んだ画像で作成（{chosen.length} 枚）
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

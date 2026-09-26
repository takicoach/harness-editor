import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  MATERIAL_KINDS,
  assetUrl,
  buildMaterialRows,
  type MaterialKind,
} from './materialList';
import { VideoThumb } from './VideoThumb';
import { useAudioClips } from '../audio/useAudioClips';
import { normalizedVolumeFromSamples } from '../audio/loudness';
import { Waveform } from '../timeline/Waveform';
import { TrashIcon } from '../icons/TrashIcon';
import { MATERIAL_UPLOAD_ACCEPT } from '../uploadMaterial';

interface MaterialLibraryProps {
  kind: MaterialKind;
  onPickKind: (kind: MaterialKind) => void;
  seLibrary: string[];
  imageLibrary: string[];
  bgmLibrary: string[];
  videoLibrary: string[];
  projectId: string;
  /** ライブラリ各ファイルの size-mtime トークン。asset URL の &v=（同名差し替えバスト）用。 */
  assetVersions?: Record<string, string>;
  /** 試聴中アセットの URL（無ければ null）。 */
  playingPath: string | null;
  /** 試聴トグル（URL＋音量を渡す）。 */
  onAudition: (url: string, volume?: number) => void;
  /** 試聴停止（タブ切替時）。 */
  onAuditionStop?: () => void;
  /** クリック挿入（再生ヘッド位置）。 */
  onInsert: (kind: MaterialKind, file: string) => void;
  /** ドラッグ開始（任意位置挿入）。未指定なら掴めない。 */
  onDragStart?: (kind: MaterialKind, file: string, e: React.PointerEvent) => void;
  /** Finder 等からの OS ファイルドロップ。未指定ならドロップ受付なし。 */
  onDropFiles?: (files: File[]) => void;
  /** アップロード進行表示（「アップロード中… 残りn件」）。null なら非表示。 */
  uploadStatus?: string | null;
  /** 素材のゴミ箱移動。未指定なら削除 UI を出さない。 */
  onDelete?: (kind: MaterialKind, file: string) => void;
  /** ゴミ箱一覧を開く。未指定ならボタンを出さない。 */
  onOpenTrash?: () => void;
}

export function MaterialLibrary({
  kind,
  onPickKind,
  seLibrary,
  imageLibrary,
  bgmLibrary,
  videoLibrary,
  projectId,
  assetVersions,
  playingPath,
  onAudition,
  onAuditionStop,
  onInsert,
  onDragStart,
  onDropFiles,
  uploadStatus,
  onDelete,
  onOpenTrash,
}: MaterialLibraryProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // OS ファイルをドラッグで重ねている間のハイライト。dragenter/leave は子要素間の
  // 出入りでも発火するため、カウンタで実際の出入りだけを判定する。
  const [dragDepth, setDragDepth] = useState(0);
  // タブ（kind）を切り替えたら選択をリセット＋試聴停止。
  useEffect(() => { setSelected(null); }, [kind]);
  useEffect(() => { onAuditionStop?.(); }, [kind, onAuditionStop]);

  // kind は必ず4種のいずれかなので find は必ずヒットする。
  const meta = MATERIAL_KINDS.find((m) => m.kind === kind)!;
  const library =
    kind === 'se'
      ? seLibrary
      : kind === 'image'
        ? imageLibrary
        : kind === 'bgm'
          ? bgmLibrary
          : videoLibrary;
  const rows = buildMaterialRows(kind, library);

  // SE/BGM のみデコード（波形＋ラウドネス測定用）。画像/動画は null。
  const isAudio = kind === 'se' || kind === 'bgm';
  const audioClips = useAudioClips(
    rows.map((r) => (isAudio ? assetUrl(projectId, r.assetPath, assetVersions) : null)),
  );

  const dropHandlers = onDropFiles === undefined ? {} : {
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragDepth((d) => d + 1);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      setDragDepth((d) => Math.max(0, d - 1));
    },
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragDepth(0);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onDropFiles(files);
    },
  };

  return (
    <div className={'material-lib' + (dragDepth > 0 ? ' ml-dragover' : '')} {...dropHandlers}>
      {dragDepth > 0 && (
        <div className="ml-drop-hint">ここにドロップして素材を追加</div>
      )}
      {uploadStatus !== null && uploadStatus !== undefined && (
        <div className="ml-upload-status" role="status">{uploadStatus}</div>
      )}
      <div className="ml-tabs" role="tablist">
        {MATERIAL_KINDS.map((m) => (
          <button
            key={m.kind}
            type="button"
            role="tab"
            className={'ml-tab' + (m.kind === kind ? ' active' : '')}
            data-kind={m.kind}
            onClick={() => onPickKind(m.kind)}
          >
            {m.label}
          </button>
        ))}
        {onOpenTrash !== undefined && (
          <button
            type="button"
            className="ml-trash-open"
            title="ゴミ箱（削除した素材の復元）"
            onClick={onOpenTrash}
          >
            ゴミ箱
          </button>
        )}
      </div>

      {onDropFiles !== undefined && <>
        <input ref={fileInput} type="file" hidden multiple accept={MATERIAL_UPLOAD_ACCEPT}
          aria-label="取り込む素材ファイル" onChange={event => {
            const files = Array.from(event.currentTarget.files ?? []);
            // Allow retrying the same file after a failed upload or cancellation.
            event.currentTarget.value = '';
            if (files.length > 0) onDropFiles(files);
          }} />
        <button type="button" className="ml-import" onClick={() => fileInput.current?.click()}>素材を読み込む</button>
      </>}
      {rows.length === 0 ? (
        <div className="ml-empty">
          <p className="ml-empty-title">{meta.emptyTitle}</p>
          <p className="ml-empty-hint">{meta.emptyHint}</p>
          <button
            type="button"
            className="ml-open-folder"
            onClick={() => {
              void fetch(
                `/api/materials/open-folder?id=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(kind)}`,
                { method: 'POST' },
              ).catch((err: unknown) => {
                // Finder を開くだけの補助操作。失敗しても編集は継続できるため UI はブロックしないが、
                // 無言で消すと「なぜ開かないのか」が分からなくなるので console には残す。
                console.warn('[material-library] open-folder failed:', err);
              });
            }}
          >
            フォルダを開く
          </button>
        </div>
      ) : meta.isThumb ? (
        <div className="ml-grid">
          {rows.map((row) => (
            <button
              key={row.file}
              type="button"
              className={'ml-cell' + (selected === row.file ? ' selected' : '')}
              title={row.file}
              onPointerDown={(e) => onDragStart?.(kind, row.file, e)}
              onClick={() => setSelected(row.file)}
            >
              <div className="ml-thumb">
                {kind === 'image' ? (
                  <img src={assetUrl(projectId, row.assetPath, assetVersions)} alt="" draggable={false} />
                ) : (
                  <VideoThumb src={assetUrl(projectId, row.assetPath, assetVersions)} />
                )}
              </div>
              <div className="ml-cell-name">{row.file}</div>
              <span
                className="ml-cell-insert"
                role="button"
                title="挿入"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onInsert(kind, row.file); }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onInsert(kind, row.file);
                  }
                }}
              >
                挿入
              </span>
              {onDelete !== undefined && (
                <span
                  className="ml-cell-delete"
                  role="button"
                  title="ゴミ箱へ移動"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(kind, row.file);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onDelete(kind, row.file);
                    }
                  }}
                >
                  <TrashIcon size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="ml-list">
          {rows.map((row, i) => {
            const url = assetUrl(projectId, row.assetPath, assetVersions);
            const playing = playingPath === url;
            const samples = audioClips[i]?.clip?.samples ?? null;
            const decodeFailed = audioClips[i]?.failed ?? false;
            const auditionVolume = samples !== null
              ? normalizedVolumeFromSamples(samples, kind === 'bgm' ? 'bgm' : 'se')
              : undefined;
            return (
              <div
                key={row.file}
                className={'ml-row' + (selected === row.file ? ' selected' : '') + (playing ? ' playing' : '')}
                onPointerDown={(e) => onDragStart?.(kind, row.file, e)}
                onClick={() => { setSelected(row.file); onAudition(url, auditionVolume); }}
              >
                <span className="ml-row-wave-wrap">
                  <Waveform samples={samples} width={120} height={20} className="ml-row-wave" />
                  {decodeFailed && (
                    <span className="ml-row-wave-error" title="音声を読み込めませんでした（破損ファイル・非対応形式の可能性）">
                      波形なし
                    </span>
                  )}
                </span>
                <span className="ml-row-name">{row.file}</span>
                <span className="ml-row-state">{playing ? '再生中' : ''}</span>
                <span
                  className="ml-insert"
                  role="button"
                  title="挿入"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); onInsert(kind, row.file); }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      onInsert(kind, row.file);
                    }
                  }}
                >
                  挿入
                </span>
                {onDelete !== undefined && (
                  <span
                    className="ml-row-delete"
                    role="button"
                    title="ゴミ箱へ移動"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(kind, row.file);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        onDelete(kind, row.file);
                      }
                    }}
                  >
                    <TrashIcon size={14} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

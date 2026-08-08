import { useEffect, useRef, useState } from 'react';
import { Waveform } from '../timeline/Waveform';
import { useWaveformSamples } from '../audio/useWaveformSamples';
import { commitInPointDrag } from './inPointDrag';
import { assetUrl } from './materialList';

interface VideoSyncWaveformProps {
  /** API id（asset URL の組み立て）。 */
  projectId: string;
  /** ライブラリ各ファイルの size-mtime トークン。asset URL の &v=（同名差し替えバスト）用。 */
  assetVersions?: Record<string, string>;
  /** サブ動画ファイル（public 相対パス）。空なら波形なし。 */
  file: string;
  /** 現在のイン点（sourceInFrame）。 */
  sourceInFrame: number;
  /** クリップの表示長（フレーム）。左右ドラッグの感度（全幅 ≒ 1 クリップ長）に使う。 */
  durationFrames: number;
  /** プロジェクト fps（durationFrames が 0 のときの感度フォールバック）。 */
  fps: number;
  /** ドラッグ追従（履歴を積まない）。 */
  onLive: (sourceInFrame: number) => void;
  /** ドラッグ確定（履歴を 1 件積む）。 */
  onCommit: (sourceInFrame: number) => void;
}

const WAVEFORM_HEIGHT = 44;

/**
 * 選択サブ動画の音声波形を表示し、左右ドラッグでイン点（sourceInFrame）を相対調整する手動同期ガイド。
 * 波形はサブ動画の音声全体の視覚リファレンス。感度は「全幅 = クリップ表示長」（durationFrames/全幅）で
 * 細かく合わせやすい。精密な数値指定は Inspector の sourceInFrame 数値入力（Task 11）で行う。
 * サブ動画はソース総尺メタを持たないためここは絶対位置でなく相対ナッジ。
 * 波形取得失敗（音声なし・取得失敗）は薄い注記のまま操作のみ継続（グレースフル）。
 */
export function VideoSyncWaveform({
  projectId,
  assetVersions,
  file,
  sourceInFrame,
  durationFrames,
  fps,
  onLive,
  onCommit,
}: VideoSyncWaveformProps) {
  const url = file === '' ? null : assetUrl(projectId, file, assetVersions);
  const samples = useWaveformSamples(url);
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<{ startX: number; startIn: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // onLive/onCommit を ref に逃がしドラッグ effect の依存を安定させる。
  const cbRef = useRef({ onLive, onCommit });
  useEffect(() => {
    cbRef.current = { onLive, onCommit };
  });

  // 自要素の幅を測る（波形幅＋ドラッグ感度に使う）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setWidth(r.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const framesPerPx = width > 0 && durationFrames > 0 ? durationFrames / width : Math.max(1, fps) / 2;
    function nextFrom(e: PointerEvent): number {
      const d = dragRef.current;
      if (d === null) return 0; // dragging===true の間しか呼ばれないので到達しない
      return Math.max(0, Math.round(d.startIn + (e.clientX - d.startX) * framesPerPx));
    }
    function onMove(e: PointerEvent): void {
      if (dragRef.current === null) return;
      cbRef.current.onLive(nextFrom(e));
    }
    function onUp(e: PointerEvent): void {
      const d = dragRef.current;
      if (d === null) return;
      const next = nextFrom(e);
      dragRef.current = null;
      setDragging(false);
      // drag 中の onLive(setTransient) が現在の履歴エントリを潰すので、commit 前に pre-drag の
      // イン点へ戻してから final を積む（Undo が pre-drag に戻るようにする）。詳細は inPointDrag.ts。
      commitInPointDrag(d.startIn, next, cbRef.current);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, width, durationFrames, fps]);

  function onPointerDown(e: React.PointerEvent): void {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startIn: sourceInFrame };
    setDragging(true);
  }

  return (
    <div
      ref={rootRef}
      onPointerDown={onPointerDown}
      title="左右ドラッグで再生開始位置（サブ動画のどこから流すか）を調整"
      style={{
        position: 'relative',
        width: '100%',
        height: WAVEFORM_HEIGHT,
        cursor: 'ew-resize',
        userSelect: 'none',
        touchAction: 'none',
        background: 'var(--bg-1)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <Waveform samples={samples} width={width} height={WAVEFORM_HEIGHT} />
      {samples === null && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            color: 'var(--fg-3)',
            pointerEvents: 'none',
          }}
        >
          波形なし（音声なし／取得失敗）
        </div>
      )}
    </div>
  );
}

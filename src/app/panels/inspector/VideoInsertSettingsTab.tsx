import { useState, useEffect } from 'react';
import { playbackToOriginal, originalToPlayback } from '../../../core/cutEngine';
import { formatClock, frameToSec, parseSecField } from '../../../shared/format';
import type { EditorVideoInsert } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import {
  retimeVideoInsert, setVideoInsertFile, setVideoInsertScale, setVideoInsertInPoint, setVideoInsertPlaybackRate,
  applySourceOffsetToFile, removeVideoInsert, setVideoInsertEnter, setVideoInsertExit,
  videoInsertMaxEnd, videoInsertOverflowFrames,
} from '../../edit/videoInsertOps';
import { VideoSyncWaveform } from '../VideoSyncWaveform';
import { AnimControls, sliderToRate, rateToSlider } from './shared';

interface VideoInsertSettingsTabProps {
  videoInsert: EditorVideoInsert;
  state: EditState;
  fps: number;
  videoLibrary: string[];
  /**
   * サブ動画素材の実フレーム長（file → frames）。未プローブ・読めない素材はキーごと存在しない。
   * 実尺が分かる素材だけ「素材の長さ」を出し、区間を素材内へクランプする。
   * **任意にしない**: 渡し忘れるとクランプが silent OFF になるため、tsc に検出させる。
   */
  videoDurations: Record<string, number>;
  projectId: string;
  assetVersions?: Record<string, string>;
  onLive: (next: EditState) => void;
  onEdit: (next: EditState) => void;
}

/** サブ動画選択時のインスペクタ本体（ファイル・大きさ・イン点同期・表示区間・削除）。 */
export function VideoInsertSettingsTab({ videoInsert, state, fps, videoLibrary, videoDurations, projectId, assetVersions, onLive, onEdit }: VideoInsertSettingsTabProps) {
  const playbackStart = originalToPlayback(videoInsert.originalStart, state.cutRegions);
  const playbackEnd = originalToPlayback(videoInsert.originalEnd, state.cutRegions);
  const shownStart = playbackStart ?? videoInsert.originalStart;
  const shownEnd = playbackEnd ?? videoInsert.originalEnd;
  const editable = playbackStart !== null && playbackEnd !== null;
  const scale = videoInsert.scale ?? 1;
  const rate = videoInsert.playbackRate ?? 1;
  const rateLabel = Number.isInteger(rate) ? `${rate}x` : `${rate.toFixed(2)}x`;
  const sourceInFrame = videoInsert.sourceInFrame;
  const durationFrames = videoInsert.originalEnd - videoInsert.originalStart;
  const sourceWindowFrames = Math.max(1, Math.round(durationFrames * rate));
  const fileOptions = videoLibrary.includes(videoInsert.file)
    ? videoLibrary
    : [videoInsert.file, ...videoLibrary];

  // 素材の実フレーム長（プローブ済みのファイルのみ）。未知なら実尺表示もクランプもしない。
  const sourceFrames = videoDurations[videoInsert.file];
  // 参照先がライブラリに無い（ファイル欠落・リネーム）。プローブは走らないので「確認中」にしない。
  const missingFromLibrary = !videoLibrary.includes(videoInsert.file);
  // イン点や速度の変更で素材の終端を越えた量（ソース座標のフレーム数）。
  const overflowFrames = videoInsertOverflowFrames(videoInsert, sourceFrames, state.cutRegions);
  const overflowing = overflowFrames !== null && overflowFrames > 0;
  /** 確定する start を基準にした originalEnd の上限（実尺不明なら undefined＝クランプなし）。 */
  const endLimit = (start: number): number | undefined =>
    videoInsertMaxEnd(videoInsert, sourceFrames, start, state.cutRegions);

  const [startStr, setStartStr] = useState(frameToSec(shownStart, fps).toFixed(2));
  const [endStr, setEndStr] = useState(frameToSec(shownEnd, fps).toFixed(2));
  const [inStr, setInStr] = useState(frameToSec(sourceInFrame, fps).toFixed(2));
  useEffect(() => { setStartStr(frameToSec(shownStart, fps).toFixed(2)); }, [shownStart, fps]);
  useEffect(() => { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); }, [shownEnd, fps]);
  useEffect(() => { setInStr(frameToSec(sourceInFrame, fps).toFixed(2)); }, [sourceInFrame, fps]);

  function commitStart(): void {
    const frame = parseSecField(startStr, shownStart, fps);
    if (frame === null) { setStartStr(frameToSec(shownStart, fps).toFixed(2)); return; }
    const start = playbackToOriginal(frame, state.cutRegions);
    onEdit(retimeVideoInsert(state, videoInsert.id, start, videoInsert.originalEnd, endLimit(start)));
  }
  function commitEnd(): void {
    const frame = parseSecField(endStr, shownEnd, fps);
    if (frame === null) { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); return; }
    onEdit(retimeVideoInsert(
      state,
      videoInsert.id,
      videoInsert.originalStart,
      playbackToOriginal(frame, state.cutRegions),
      endLimit(videoInsert.originalStart),
    ));
  }
  function commitIn(): void {
    const frame = parseSecField(inStr, sourceInFrame, fps);
    if (frame === null) { setInStr(frameToSec(sourceInFrame, fps).toFixed(2)); return; }
    onEdit(setVideoInsertInPoint(state, videoInsert.id, frame));
  }

  return (
    <>
      <div className="ins-section">
        <div className="ins-label"><span>サブ動画 #{videoInsert.id}</span></div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
          {`${formatClock(frameToSec(videoInsert.originalStart, fps))} — ${formatClock(frameToSec(videoInsert.originalEnd, fps))}`}
        </div>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>サブ動画ファイル</span></div>
        <select
          className="hl-input"
          value={videoInsert.file}
          onChange={(e) => onEdit(setVideoInsertFile(state, videoInsert.id, e.target.value))}
        >
          {fileOptions.map((f) => (<option key={f} value={f}>{f}</option>))}
        </select>
        {/* 素材の実尺。プローブできた素材だけ出す（不明なまま推定値を出さない）。 */}
        <p className="ins-vi-source-len">
          {sourceFrames !== undefined
            ? `素材の長さ: ${formatClock(frameToSec(sourceFrames, fps))}（${frameToSec(sourceFrames, fps).toFixed(2)} 秒）`
            : missingFromLibrary
              // ライブラリに無い＝ファイル自体が消えている/名前が違う。プローブは永遠に終わらないので
              // 「確認中」と出し続けると原因を誤解させる。
              ? '素材が見つかりません（public/ にファイルがありません）。プレビューにも表示されません'
              : '素材の長さ: 確認中（読み取れない素材は区間を制限しません）'}
        </p>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>大きさ {scale.toFixed(2)}</span></div>
        <input
          type="range"
          min={0.1}
          max={5}
          step={0.05}
          value={scale}
          onChange={(e) => onEdit(setVideoInsertScale(state, videoInsert.id, Number(e.target.value)))}
        />
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>再生速度 </span><span className="ins-vi-speed-value">{rateLabel}</span></div>
        <input
          id="ins-vi-speed"
          type="range"
          min={0}
          max={1000}
          step={1}
          value={rateToSlider(rate)}
          onChange={(e) => onEdit(setVideoInsertPlaybackRate(state, videoInsert.id, sliderToRate(Number(e.target.value))))}
        />
        <div className="ins-vi-speed-presets">
          {[0.25, 0.5, 1, 2, 4, 8, 16].map((p) => (
            <button
              key={p}
              className="tx-mini-btn ins-vi-speed-preset"
              data-rate={p}
              onClick={() => onEdit(setVideoInsertPlaybackRate(state, videoInsert.id, p))}
            >
              {`${p}x`}
            </button>
          ))}
        </div>
        {rate <= 0.5 && (
          <p className="ins-vi-speed-warn" style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 0' }}>
            元動画の fps によってはカクつくことがあります。
          </p>
        )}
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>再生開始位置を合わせる</span></div>
        <VideoSyncWaveform
          projectId={projectId}
          assetVersions={assetVersions}
          file={videoInsert.file}
          sourceInFrame={sourceInFrame}
          durationFrames={sourceWindowFrames}
          fps={fps}
          onLive={(f) => { if (editable) onLive(setVideoInsertInPoint(state, videoInsert.id, f)); }}
          onCommit={(f) => { if (editable) onEdit(setVideoInsertInPoint(state, videoInsert.id, f)); }}
        />
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-vi-in">再生開始位置</label>
            <input
              id="ins-vi-in"
              type="number"
              step={0.1}
              value={inStr}
              disabled={!editable}
              onChange={(e) => setInStr(e.target.value)}
              onBlur={() => editable && commitIn()}
              onKeyDown={(e) => { if (e.key === 'Enter' && editable) commitIn(); }}
            />
          </div>
        </div>
        {/* イン点は波形で合わせる同期点なので勝手にクランプしない。代わりに超過を知らせる
            （区間の伸ばしすぎは retimeVideoInsert 側でクランプ済み・ここはイン点/速度由来）。 */}
        {overflowing && (
          <p className="ins-vi-overflow-warn">
            素材の終わりを {frameToSec(overflowFrames ?? 0, fps).toFixed(2)} 秒ぶん超えています。
            超えた分は最後のコマで静止します（再生開始位置を戻すか、表示する時間を短くしてください）。
          </p>
        )}
        <button
          className="tx-mini-btn"
          onClick={() => onEdit(applySourceOffsetToFile(state, videoInsert.id))}
          title="同じサブ動画ファイルの他クリップにも、このクリップのズレ（再生開始位置 − 表示開始）を適用します"
        >
          このソースの他クリップにも適用
        </button>
      </div>

      <AnimControls
        idPrefix="ins-video-enter"
        label="登場アニメ"
        value={videoInsert.enter}
        onChange={(a) => onEdit(setVideoInsertEnter(state, videoInsert.id, a))}
        defaultKind="none"
      />
      <AnimControls
        idPrefix="ins-video-exit"
        label="退場アニメ"
        value={videoInsert.exit}
        onChange={(a) => onEdit(setVideoInsertExit(state, videoInsert.id, a))}
        defaultKind="none"
      />

      <div className="ins-section">
        <div className="ins-label"><span>表示する時間（秒）</span></div>
        {!editable && (
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 6px' }}>
            このサブ動画はカット区間内にあります。ここでは編集できません。
            このまま保存するとカット端へ寄せて出力されます（位置は復元できません）。
          </p>
        )}
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-vi-start">開始</label>
            <input
              id="ins-vi-start"
              type="number"
              step={0.1}
              value={startStr}
              disabled={!editable}
              onChange={(e) => setStartStr(e.target.value)}
              onBlur={() => editable && commitStart()}
              onKeyDown={(e) => { if (e.key === 'Enter' && editable) commitStart(); }}
            />
          </div>
          <div className="num-field">
            <label htmlFor="ins-vi-end">終了</label>
            <input
              id="ins-vi-end"
              type="number"
              step={0.1}
              value={endStr}
              disabled={!editable}
              onChange={(e) => setEndStr(e.target.value)}
              onBlur={() => editable && commitEnd()}
              onKeyDown={(e) => { if (e.key === 'Enter' && editable) commitEnd(); }}
            />
          </div>
        </div>
      </div>

      <div className="ins-section">
        <button className="tx-mini-btn" onClick={() => onEdit(removeVideoInsert(state, videoInsert.id))}>
          このサブ動画を削除
        </button>
      </div>
    </>
  );
}

import { AssetTimingSection, useAssetTimingDisplay } from './AssetTimingSection';
import { useState, useEffect } from 'react';
import { cutOrderingOf } from '../../../core/cutOrder';
import { playbackToOriginal, originalToPlayback } from '../../../core/cutEngine';
import { videoInsertSourceOverflowFrames, videoInsertHasNoPlayableFrames } from '../../../core/videoInsertEngine';
import { formatClock, frameToSec, parseSecField } from '../../../shared/format';
import type { EditorVideoInsert } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import {
  retimeVideoInsert, setVideoInsertFile, setVideoInsertScale, setVideoInsertInPoint, setVideoInsertPlaybackRate,
  applySourceOffsetToFile, removeVideoInsert, setVideoInsertEnter, setVideoInsertExit,
} from '../../edit/videoInsertOps';
import { assetUrl } from '../materialList';
import { useSourceDurationFrames } from '../../audio/useSourceDurationFrames';
import { VideoSyncWaveform } from '../VideoSyncWaveform';
import { AnimControls, sliderToRate, rateToSlider } from './shared';

interface VideoInsertSettingsTabProps {
  videoInsert: EditorVideoInsert;
  /** Rate on the final timeline, including main-video speed. */
  effectivePlaybackRate?: number;
  state: EditState;
  fps: number;
  videoLibrary: string[];
  projectId: string;
  assetVersions?: Record<string, string>;
  onLive: (next: EditState) => void;
  onEdit: (next: EditState) => void;
}

/** サブ動画選択時のインスペクタ本体（ファイル・大きさ・イン点同期・表示区間・削除）。 */
export function VideoInsertSettingsTab({ videoInsert, effectivePlaybackRate, state, fps, videoLibrary, projectId, assetVersions, onLive, onEdit }: VideoInsertSettingsTabProps) {
  const timing = useAssetTimingDisplay();
  const playbackStart = originalToPlayback(videoInsert.originalStart, state.cutRegions, cutOrderingOf(state));
  const playbackEnd = originalToPlayback(videoInsert.originalEnd, state.cutRegions, cutOrderingOf(state), 'end');
  const shownStart = playbackStart ?? videoInsert.originalStart;
  const shownEnd = playbackEnd ?? videoInsert.originalEnd;
  const editable = timing !== null || (playbackStart !== null && playbackEnd !== null);
  const scale = videoInsert.scale ?? 1;
  const rate = videoInsert.playbackRate ?? 1;
  const rateLabel = Number.isInteger(rate) ? `${rate}x` : `${rate.toFixed(2)}x`;
  const sourceInFrame = videoInsert.sourceInFrame;
  const durationFrames = timing ? timing.end - timing.start : videoInsert.originalEnd - videoInsert.originalStart;
  const sourceWindowFrames = Math.max(1, Math.round(durationFrames * (timing ? effectivePlaybackRate ?? rate : rate)));
  const fileOptions = videoLibrary.includes(videoInsert.file)
    ? videoLibrary
    : [videoInsert.file, ...videoLibrary];

  // ソース長超過ヒント（R-1）。デコードは VideoSyncWaveform の波形取得と同じ副産物なので追加コストは低い。
  // 音声なし・取得失敗で長さ不明なら null（警告なし）。実クランプは保存時にサーバ側 ffprobe が担う。
  const subUrl = videoInsert.file === '' ? null : assetUrl(projectId, videoInsert.file, assetVersions);
  const sourceLengthFrames = useSourceDurationFrames(subUrl, fps);
  const overflowFrames = videoInsertSourceOverflowFrames(videoInsert, sourceLengthFrames);
  const overflowSec = overflowFrames !== null && overflowFrames > 0 ? frameToSec(overflowFrames, fps) : null;
  // X-2(a): 超過の中でも「クランプでは直せない＝再生できるフレームが1枚も残っていない」場合は
  // 「保存時に自動調整されます」が嘘になる（保存しても直らない）。取るべき行動ごと出し分ける。
  const noPlayableFrames = videoInsertHasNoPlayableFrames(videoInsert, sourceLengthFrames);

  const [startStr, setStartStr] = useState(frameToSec(shownStart, fps).toFixed(2));
  const [endStr, setEndStr] = useState(frameToSec(shownEnd, fps).toFixed(2));
  const [inStr, setInStr] = useState(frameToSec(sourceInFrame, fps).toFixed(2));
  useEffect(() => { setStartStr(frameToSec(shownStart, fps).toFixed(2)); }, [shownStart, fps]);
  useEffect(() => { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); }, [shownEnd, fps]);
  useEffect(() => { setInStr(frameToSec(sourceInFrame, fps).toFixed(2)); }, [sourceInFrame, fps]);

  function commitStart(): void {
    const frame = parseSecField(startStr, shownStart, fps);
    if (frame === null) { setStartStr(frameToSec(shownStart, fps).toFixed(2)); return; }
    onEdit(retimeVideoInsert(state, videoInsert.id, playbackToOriginal(frame, state.cutRegions, cutOrderingOf(state)), videoInsert.originalEnd));
  }
  function commitEnd(): void {
    const frame = parseSecField(endStr, shownEnd, fps);
    if (frame === null) { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); return; }
    onEdit(retimeVideoInsert(state, videoInsert.id, videoInsert.originalStart, playbackToOriginal(frame, state.cutRegions, cutOrderingOf(state))));
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
          {timing?.label ?? `${formatClock(frameToSec(videoInsert.originalStart, fps))} — ${formatClock(frameToSec(videoInsert.originalEnd, fps))}`}
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
        <button
          className="tx-mini-btn"
          onClick={() => onEdit(applySourceOffsetToFile(state, videoInsert.id))}
          title="同じサブ動画ファイルの他クリップにも、このクリップのズレ（再生開始位置 − 表示開始）を適用します"
        >
          このソースの他クリップにも適用
        </button>
        {overflowSec !== null && (
          <p
            className="ins-vi-source-overflow-warn"
            style={{ fontSize: 11, color: 'var(--danger, #c0392b)', margin: '6px 0 0' }}
          >
            {noPlayableFrames
              ? 'このサブ動画は再生できる範囲が残っていません（開始位置がソースの終わりより後です）。開始位置を戻すか、クリップを削除してください。'
              : `再生開始位置から先がソースの実長を約${overflowSec.toFixed(2)}秒超えています。保存時に終了位置が自動調整されます。`}
          </p>
        )}
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

<AssetTimingSection>
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
      </AssetTimingSection>

      <div className="ins-section">
        <button className="tx-mini-btn" onClick={() => onEdit(removeVideoInsert(state, videoInsert.id))}>
          このサブ動画を削除
        </button>
      </div>
    </>
  );
}

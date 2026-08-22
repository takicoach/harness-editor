import { useState, useEffect } from 'react';
import { cutOrderingOf } from '../../../core/cutOrder';
import { playbackToOriginal, originalToPlayback } from '../../../core/cutEngine';
import { formatClock, frameToSec, parseSecField } from '../../../shared/format';
import type { EditorImage, ImageType } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import {
  retimeImage, setImageScale, setImageType, setImageFile, removeImage,
  setImageOpacity, setImageRotation, setImageEnter, setImageExit, setImageMotion,
} from '../../edit/imageOps';
import { AnimControls } from './shared';
import { MotionSettings } from './MotionSettings';

interface ImageSettingsTabProps {
  image: EditorImage;
  state: EditState;
  fps: number;
  imageLibrary: string[];
  onEdit: (next: EditState) => void;
}

/** 画像選択時のインスペクタ本体（ファイル・タイプ・スケール・表示する時間・削除）。 */
export function ImageSettingsTab({ image, state, fps, imageLibrary, onEdit }: ImageSettingsTabProps) {
  // 再生（カット後）フレームでユーザーに見せる。カット区間内なら null。
  const playbackStart = originalToPlayback(image.originalStart, state.cutRegions, cutOrderingOf(state));
  const playbackEnd = originalToPlayback(image.originalEnd, state.cutRegions, cutOrderingOf(state), 'end');
  const shownStart = playbackStart ?? image.originalStart;
  const shownEnd = playbackEnd ?? image.originalEnd;
  const editable = playbackStart !== null && playbackEnd !== null;
  // scale 未指定は 1 既定（playbackModel の `?? 1` および InsertImage.tsx の `?? 1` と一致）。
  const scale = image.scale ?? 1;
  const opacity = image.opacity ?? 1;
  const rotation = image.rotation ?? 0;
  // 現在のファイルがライブラリに無くても選べるよう先頭へ補う。
  const fileOptions = imageLibrary.includes(image.file)
    ? imageLibrary
    : [image.file, ...imageLibrary];

  const [startStr, setStartStr] = useState(frameToSec(shownStart, fps).toFixed(2));
  const [endStr, setEndStr] = useState(frameToSec(shownEnd, fps).toFixed(2));
  useEffect(() => {
    setStartStr(frameToSec(shownStart, fps).toFixed(2));
  }, [shownStart, fps]);
  useEffect(() => {
    setEndStr(frameToSec(shownEnd, fps).toFixed(2));
  }, [shownEnd, fps]);

  function commitStart(): void {
    const frame = parseSecField(startStr, shownStart, fps);
    if (frame === null) { setStartStr(frameToSec(shownStart, fps).toFixed(2)); return; }
    onEdit(retimeImage(state, image.id, playbackToOriginal(frame, state.cutRegions, cutOrderingOf(state)), image.originalEnd));
  }

  function commitEnd(): void {
    const frame = parseSecField(endStr, shownEnd, fps);
    if (frame === null) { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); return; }
    onEdit(retimeImage(state, image.id, image.originalStart, playbackToOriginal(frame, state.cutRegions, cutOrderingOf(state))));
  }

  return (
    <>
      <div className="ins-section">
        <div className="ins-label">
          <span>挿入画像 #{image.id}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
          {`${formatClock(frameToSec(image.originalStart, fps))} — ${formatClock(frameToSec(image.originalEnd, fps))}`}
        </div>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>画像ファイル</span></div>
        <select
          className="hl-input"
          value={image.file}
          onChange={(e) => onEdit(setImageFile(state, image.id, e.target.value))}
        >
          {fileOptions.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>タイプ</span></div>
        <select
          className="hl-input"
          value={image.type}
          onChange={(e) => onEdit(setImageType(state, image.id, e.target.value as ImageType))}
        >
          <option value="photo">photo（写真）</option>
          <option value="infographic">infographic（図解）</option>
          <option value="overlay">overlay（オーバーレイ）</option>
        </select>
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>スケール {scale.toFixed(2)}</span></div>
        <input
          type="range"
          min={0.1}
          max={5}
          step={0.05}
          value={scale}
          onChange={(e) => onEdit(setImageScale(state, image.id, Number(e.target.value)))}
        />
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>不透明度 {opacity.toFixed(2)}</span></div>
        <input
          id="ins-image-opacity"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => onEdit(setImageOpacity(state, image.id, Number(e.target.value)))}
        />
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>回転 {Math.round(rotation)}°</span></div>
        <input
          id="ins-image-rotation"
          type="range"
          min={-180}
          max={180}
          step={1}
          value={rotation}
          onChange={(e) => onEdit(setImageRotation(state, image.id, Number(e.target.value)))}
        />
      </div>

      <MotionSettings
        idPrefix="ins-image"
        motion={image.motion}
        withRotation
        onChange={(m) => onEdit(setImageMotion(state, image.id, m))}
      />

      <AnimControls
        idPrefix="ins-image-enter"
        label="登場アニメ"
        value={image.enter}
        onChange={(a) => onEdit(setImageEnter(state, image.id, a))}
      />
      <AnimControls
        idPrefix="ins-image-exit"
        label="退場アニメ"
        value={image.exit}
        onChange={(a) => onEdit(setImageExit(state, image.id, a))}
      />

      <div className="ins-section">
        <div className="ins-label"><span>表示する時間（秒）</span></div>
        {!editable && (
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 6px' }}>
            この画像はカット区間内にあります。ここでは編集できません。
            このまま保存するとカット端へ寄せて出力されます（位置は復元できません）。
          </p>
        )}
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-image-start">開始</label>
            <input
              id="ins-image-start"
              type="number"
              step={0.1}
              value={startStr}
              disabled={!editable}
              onChange={(e) => setStartStr(e.target.value)}
              onBlur={() => editable && commitStart()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editable) commitStart();
              }}
            />
          </div>
          <div className="num-field">
            <label htmlFor="ins-image-end">終了</label>
            <input
              id="ins-image-end"
              type="number"
              step={0.1}
              value={endStr}
              disabled={!editable}
              onChange={(e) => setEndStr(e.target.value)}
              onBlur={() => editable && commitEnd()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editable) commitEnd();
              }}
            />
          </div>
        </div>
      </div>

      <div className="ins-section">
        <button className="tx-mini-btn" onClick={() => onEdit(removeImage(state, image.id))}>
          この画像を削除
        </button>
      </div>
    </>
  );
}

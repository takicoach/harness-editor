import { AssetTimingSection, useAssetTimingDisplay } from './AssetTimingSection';
import { useState, useEffect } from 'react';
import { cutOrderingOf } from '../../../core/cutOrder';
import { playbackToOriginal, originalToPlayback } from '../../../core/cutEngine';
import { frameToSec, parseSecField } from '../../../shared/format';
import type { EditorImage, ImageType } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import {
  retimeImage, setImageScale, setImageType, setImageFile, removeImage,
  setImageOpacity, setImageRotation, setImageEnter, setImageExit, setImageMotion, setImagePosition,
} from '../../edit/imageOps';
import { AnimControls, InstallCtaButton } from './shared';
import type { InstallKind, InstallErrors } from '../../install';
import { MotionSettings } from './MotionSettings';
import { IMAGE_KEYFRAMES_UNSUPPORTED } from '../../../shared/motionKeys';

function ImageNumberField({ id, label, value, min, max, onCommit }: {
  id: string; label: string; value: number; min: number; max: number; onCommit: (value: number) => void;
}) {
  const format = (n: number) => String(Number(n.toFixed(6)));
  const [draft, setDraft] = useState(format(value));
  useEffect(() => setDraft(format(value)), [value]);
  return <div className="num-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="number" step="any" min={min} max={max} value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={e => {
        const raw = e.currentTarget.value.trim();
        const parsed = Number(raw);
        if (!raw || !Number.isFinite(parsed)) { setDraft(format(value)); return; }
        const next = Math.min(max, Math.max(min, parsed));
        setDraft(format(next));
        if (next !== value) onCommit(next);
      }}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== 'Escape') return;
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { e.currentTarget.value = format(value); setDraft(format(value)); }
        e.currentTarget.blur();
      }} />
  </div>;
}

interface ImageSettingsTabProps {
  image: EditorImage;
  state: EditState;
  fps: number;
  imageLibrary: string[];
  /** 画像のキーフレームが書き出しへ反映されるか（未指定＝対応済み扱い）。 */
  keyframesSupported?: boolean;
  renderingSupport?: { supported: boolean; canUpgrade: boolean };
  installing?: InstallKind | null;
  installErrors?: InstallErrors;
  dirty?: boolean;
  onInstall?: (kind: InstallKind) => void;
  onEdit: (next: EditState) => void;
}

/** 画像選択時のインスペクタ本体（ファイル・タイプ・スケール・表示する時間・削除）。 */
export function ImageSettingsTab({ image, state, fps, imageLibrary, keyframesSupported = true,
  renderingSupport = { supported: false, canUpgrade: false }, installing = null, installErrors = {}, dirty = false, onInstall, onEdit }: ImageSettingsTabProps) {
  const timing = useAssetTimingDisplay();
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
          {timing?.label ?? <>{`原素材 ${Number(frameToSec(image.originalStart, fps).toFixed(6))}–${Number(frameToSec(image.originalEnd, fps).toFixed(6))} 秒`}
          <br />
          {`${image.originalStart}–${image.originalEnd} フレーム（終了は含まない）`}</>}
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
        <div className="ins-label"><span>表示方法</span></div>
        <select
          aria-label="画像の表示方法"
          className="hl-input"
          value={image.type}
          onChange={(e) => onEdit(setImageType(state, image.id, e.target.value as ImageType))}
        >
          <option value="plain" disabled={!renderingSupport.supported}>静止画像（そのまま配置）</option>
          <option value="photo">写真（ゆっくり拡大）</option>
          <option value="infographic">図解（枠付き）</option>
          <option value="overlay">強調（背景を暗く）</option>
        </select>
        {!renderingSupport.supported && <>
          <p className="ins-hint">静止画像と登場・退場アニメを使うには、画像表示の更新が必要です。</p>
          {renderingSupport.canUpgrade && onInstall ? <InstallCtaButton kind="imageRendering" label="画像表示を更新"
            className="btn" installing={installing} installErrors={installErrors} dirty={dirty} onInstall={onInstall} />
            : <p className="ins-hint">この案件の画像表示は個別の確認が必要です。独自の表示は保持されています。</p>}
        </>}
      </div>

      <div className="ins-section">
        <ImageNumberField id="ins-image-scale-number" label="大きさ（%）" value={scale * 100} min={10} max={500}
          onCommit={value => onEdit(setImageScale(state, image.id, value / 100))} />
        <input
          aria-label="画像の大きさ（スライダー）"
          type="range"
          min={0.1}
          max={5}
          step={0.05}
          value={scale}
          onChange={(e) => onEdit(setImageScale(state, image.id, Number(e.target.value)))}
        />
      </div>

      <div className="ins-section num-row">
        <ImageNumberField id="ins-image-x" label="横位置（%）" value={(image.position?.x ?? 0) * 100} min={-100} max={100}
          onCommit={value => onEdit(setImagePosition(state, image.id, value / 100, image.position?.y ?? 0))} />
        <ImageNumberField id="ins-image-y" label="縦位置（%）" value={(image.position?.y ?? 0) * 100} min={-100} max={100}
          onCommit={value => onEdit(setImagePosition(state, image.id, image.position?.x ?? 0, value / 100))} />
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
        base={{ x: image.position?.x ?? 0, y: image.position?.y ?? 0, scale, opacity, rotation }}
        keyframeSupport={{ supported: keyframesSupported, message: IMAGE_KEYFRAMES_UNSUPPORTED }}
        durationFrames={timing ? timing.end - timing.start : image.originalEnd - image.originalStart}
        fps={fps}
        onChange={(m) => onEdit(setImageMotion(state, image.id, m))}
      />

      <fieldset disabled={!renderingSupport.supported} style={{ border: 0, margin: 0, padding: 0 }}>
      <AnimControls
        idPrefix="ins-image-enter"
        label="登場アニメ"
        defaultKind={image.type === 'plain' ? 'none' : 'fade'}
        value={image.enter}
        onChange={(a) => onEdit(setImageEnter(state, image.id, a))}
      />
      <AnimControls
        idPrefix="ins-image-exit"
        label="退場アニメ"
        defaultKind={image.type === 'plain' ? 'none' : 'fade'}
        value={image.exit}
        onChange={(a) => onEdit(setImageExit(state, image.id, a))}
      />
      </fieldset>

<AssetTimingSection>
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
      </AssetTimingSection>

      <div className="ins-section">
        <button className="tx-mini-btn" onClick={() => onEdit(removeImage(state, image.id))}>
          この画像を削除
        </button>
      </div>
    </>
  );
}

import { useState, useEffect } from 'react';
import { cutOrderingOf } from '../../../core/cutOrder';
import { playbackToOriginal, originalToPlayback } from '../../../core/cutEngine';
import { formatClock, frameToSec, parseSecField } from '../../../shared/format';
import type { EditorShape, ShapeThickness } from '../../../core/types';
import type { EditState } from '../../edit/editState';
import { removeShape, retimeShape, setShapeColor, setShapeOpacity, setShapeThickness } from '../../edit/shapeOps';
import { SHAPE_COLORS } from '../../../core/shapeStyle';
import type { InstallKind, InstallErrors } from '../../install';
import { InstallCtaButton } from './shared';

interface ShapeSettingsTabProps {
  shape: EditorShape;
  state: EditState;
  fps: number;
  shapeInstalled: boolean;
  installing: InstallKind | null;
  installErrors: InstallErrors;
  dirty: boolean;
  onInstall: (kind: InstallKind) => void;
  onEdit: (next: EditState) => void;
}

/**
 * 図形選択時のインスペクタ本体（受入基準: 色6プリセット/太さ3段/不透明度スライダー/表示区間/CTA）。
 */
export function ShapeSettingsTab({ shape, state, fps, shapeInstalled, installing, installErrors, dirty, onInstall, onEdit }: ShapeSettingsTabProps) {
  const playbackStart = originalToPlayback(shape.originalStart, state.cutRegions, cutOrderingOf(state));
  const playbackEnd = originalToPlayback(shape.originalEnd, state.cutRegions, cutOrderingOf(state), 'end');
  const shownStart = playbackStart ?? shape.originalStart;
  const shownEnd = playbackEnd ?? shape.originalEnd;
  const editable = playbackStart !== null && playbackEnd !== null;
  const opacity = shape.opacity ?? 1;

  const [startStr, setStartStr] = useState(frameToSec(shownStart, fps).toFixed(2));
  const [endStr, setEndStr] = useState(frameToSec(shownEnd, fps).toFixed(2));
  useEffect(() => { setStartStr(frameToSec(shownStart, fps).toFixed(2)); }, [shownStart, fps]);
  useEffect(() => { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); }, [shownEnd, fps]);

  function commitStart(): void {
    const frame = parseSecField(startStr, shownStart, fps);
    if (frame === null) { setStartStr(frameToSec(shownStart, fps).toFixed(2)); return; }
    onEdit(retimeShape(state, shape.id, playbackToOriginal(frame, state.cutRegions, cutOrderingOf(state)), shape.originalEnd));
  }
  function commitEnd(): void {
    const frame = parseSecField(endStr, shownEnd, fps);
    if (frame === null) { setEndStr(frameToSec(shownEnd, fps).toFixed(2)); return; }
    onEdit(retimeShape(state, shape.id, shape.originalStart, playbackToOriginal(frame, state.cutRegions, cutOrderingOf(state))));
  }

  const THICKNESS_LABELS: Record<string, string> = { thin: '細', medium: '中', thick: '太' };

  return (
    <>
      {/* 「図形機能を導入」CTA（常設）。 */}
      <div className="ins-section">
        <div className="ins-label"><span>図形機能</span></div>
        {!shapeInstalled ? (
          <div className="ins-pack-cta">
            <p>図形は<strong>このまま描いて確認できます</strong>。最後に動画（mp4）へ書き出すときだけ、ここで「図形機能を導入」してください。</p>
            <InstallCtaButton
              kind="shape"
              label="図形機能を導入"
              className="ins-shape-install"
              installing={installing}
              installErrors={installErrors}
              dirty={dirty}
              onInstall={onInstall}
            />
          </div>
        ) : (
          <p className="ins-pack-hint">図形機能は導入済みです。</p>
        )}
      </div>

      <div className="ins-section">
        <div className="ins-label"><span>図形 #{shape.id}（{shape.kind}）</span></div>
        <div style={{ fontSize: 11, color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}>
          {`${formatClock(frameToSec(shape.originalStart, fps))} — ${formatClock(frameToSec(shape.originalEnd, fps))}`}
        </div>
      </div>

      {/* 色6プリセット（受入基準: #ins-shape-color）。 */}
      <div className="ins-section">
        <div className="ins-label"><span>色</span></div>
        <div className="ins-shape-colors" role="group" aria-label="図形の色">
          {SHAPE_COLORS.map((color) => (
            <button
              key={color}
              id={color === shape.color ? 'ins-shape-color' : undefined}
              type="button"
              className={'ins-shape-color-btn' + (shape.color === color ? ' active' : '')}
              title={color}
              aria-pressed={shape.color === color}
              style={{ background: color, border: shape.color === color ? '2px solid var(--fg-1)' : '2px solid transparent' }}
              onClick={() => onEdit(setShapeColor(state, shape.id, color))}
            />
          ))}
        </div>
      </div>

      {/* 太さ3段（受入基準: #ins-shape-thickness）。 */}
      <div className="ins-section">
        <div className="ins-label"><span>太さ</span></div>
        <div className="seg" role="group" aria-label="図形の太さ">
          {(['thin', 'medium', 'thick'] as ShapeThickness[]).map((t) => (
            <button
              key={t}
              id={t === shape.thickness ? 'ins-shape-thickness' : undefined}
              type="button"
              className={shape.thickness === t ? 'active' : ''}
              aria-pressed={shape.thickness === t}
              onClick={() => onEdit(setShapeThickness(state, shape.id, t))}
            >
              {THICKNESS_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {/* 不透明度スライダー（受入基準）。 */}
      <div className="ins-section">
        <div className="ins-label"><span>不透明度 {Math.round(opacity * 100)}%</span></div>
        <input
          id="ins-shape-opacity"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(e) => onEdit(setShapeOpacity(state, shape.id, Number(e.target.value)))}
        />
      </div>

      {/* 表示区間（秒）（受入基準）。 */}
      <div className="ins-section">
        <div className="ins-label"><span>表示する時間（秒）</span></div>
        {!editable && (
          <p style={{ fontSize: 11, color: 'var(--fg-3)', margin: '4px 0 6px' }}>
            この図形はカット区間内にあります。ここでは編集できません。
          </p>
        )}
        <div className="num-row">
          <div className="num-field">
            <label htmlFor="ins-shape-start">開始</label>
            <input
              id="ins-shape-start"
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
            <label htmlFor="ins-shape-end">終了</label>
            <input
              id="ins-shape-end"
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
        <button className="tx-mini-btn" onClick={() => onEdit(removeShape(state, shape.id))}>
          この図形を削除
        </button>
      </div>
    </>
  );
}

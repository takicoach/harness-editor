/**
 * MotionSettings — 2点アニメ（開始→終了の補間）の共通設定 UI。
 *
 * テロップ（SettingsTab）と画像（ImageSettingsTab）から使う。
 * プリセット選択＋強さスライダー＋折りたたみ詳細（開始/終了の個別上書き）。
 * 値の意味論は core/motion.ts（プリセット＝詳細値のショートカット、詳細上書きは from/to）。
 */
import { useState } from 'react';
import type { Motion, MotionPreset, MotionState } from '../../../core/motion';
import { DEFAULT_INTENSITY } from '../../../core/motion';

const PRESET_LABELS: Array<{ id: MotionPreset | 'none'; label: string }> = [
  { id: 'none', label: 'なし' },
  { id: 'zoomIn', label: 'ズームイン' },
  { id: 'zoomOut', label: 'ズームアウト' },
  { id: 'panLeft', label: '左へパン' },
  { id: 'panRight', label: '右へパン' },
  { id: 'fadeIn', label: 'フェードイン強調' },
  { id: 'custom', label: 'カスタム' },
];

export interface MotionSettingsProps {
  idPrefix: string;
  motion: Motion | undefined;
  onChange: (motion: Motion | undefined) => void;
  /** 回転の詳細指定を出すか（画像・メイン動画は true）。 */
  withRotation?: boolean;
  /** 不透明度の詳細指定を出すか（メイン動画は false）。 */
  withOpacity?: boolean;
}

/** 詳細行のスライダー1本（from/to の1軸）。 */
function DetailSlider({
  label, value, min, max, step, onChange,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <div className="ins-motion-detail-row">
      <span className="ins-motion-detail-label">
        {label} {value !== undefined ? value.toFixed(2) : '—'}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value ?? (min + max) / 2}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {value !== undefined && (
        <button type="button" className="ins-motion-detail-clear" onClick={() => onChange(undefined)}>
          ×
        </button>
      )}
    </div>
  );
}

/** from/to どちらか一方のブロック。 */
function EndpointDetails({
  title, stateValue, withRotation, withOpacity, onPatch,
}: {
  title: string;
  stateValue: MotionState | undefined;
  withRotation: boolean;
  withOpacity: boolean;
  onPatch: (patch: MotionState | undefined) => void;
}) {
  const patch = (key: keyof MotionState, v: number | undefined): void => {
    const next: MotionState = { ...stateValue };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onPatch(Object.keys(next).length > 0 ? next : undefined);
  };
  return (
    <div className="ins-motion-endpoint">
      <div className="ins-motion-endpoint-title">{title}</div>
      <DetailSlider label="横位置" value={stateValue?.x} min={-1} max={1} step={0.02} onChange={(v) => patch('x', v)} />
      <DetailSlider label="縦位置" value={stateValue?.y} min={-1} max={1} step={0.02} onChange={(v) => patch('y', v)} />
      <DetailSlider label="大きさ" value={stateValue?.scale} min={0.1} max={3} step={0.05} onChange={(v) => patch('scale', v)} />
      {withOpacity && (
        <DetailSlider label="不透明度" value={stateValue?.opacity} min={0} max={1} step={0.05} onChange={(v) => patch('opacity', v)} />
      )}
      {withRotation && (
        <DetailSlider label="回転" value={stateValue?.rotation} min={-180} max={180} step={1} onChange={(v) => patch('rotation', v)} />
      )}
    </div>
  );
}

export function MotionSettings({ idPrefix, motion, onChange, withRotation = false, withOpacity = true }: MotionSettingsProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const preset: MotionPreset | 'none' = motion?.preset ?? 'none';

  const choosePreset = (id: MotionPreset | 'none'): void => {
    if (id === 'none') {
      onChange(undefined);
      return;
    }
    // プリセット切替時は詳細上書きを引き継がない（プリセットの素の動きへ戻す）。
    onChange({ preset: id, intensity: motion?.intensity ?? DEFAULT_INTENSITY });
  };

  return (
    <div className="ins-section ins-motion" data-testid={`${idPrefix}-motion`}>
      <div className="ins-label"><span>アニメ（開始→終了）</span></div>
      <select
        id={`${idPrefix}-motion-preset`}
        value={preset}
        onChange={(e) => choosePreset(e.target.value as MotionPreset | 'none')}
      >
        {PRESET_LABELS
          .filter((p) => withOpacity || p.id !== 'fadeIn')
          .map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {motion && motion.preset !== 'custom' && (
        <div className="ins-motion-intensity">
          <div className="ins-label">
            <span>強さ {(motion.intensity ?? DEFAULT_INTENSITY).toFixed(2)}</span>
          </div>
          <input
            id={`${idPrefix}-motion-intensity`}
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={motion.intensity ?? DEFAULT_INTENSITY}
            onChange={(e) => onChange({ ...motion, intensity: Number(e.target.value) })}
          />
        </div>
      )}
      {motion && (
        <>
          <button
            type="button"
            className="ins-motion-details-toggle"
            onClick={() => setDetailsOpen((v) => !v)}
          >
            {detailsOpen ? '詳細を閉じる' : '詳細設定（開始/終了を個別調整）'}
          </button>
          {detailsOpen && (
            <div className="ins-motion-details">
              <EndpointDetails
                title="開始"
                stateValue={motion.from}
                withRotation={withRotation}
                withOpacity={withOpacity}
                onPatch={(from) => {
                  const next: Motion = { ...motion };
                  if (from) next.from = from; else delete next.from;
                  onChange(next);
                }}
              />
              <EndpointDetails
                title="終了"
                stateValue={motion.to}
                withRotation={withRotation}
                withOpacity={withOpacity}
                onPatch={(to) => {
                  const next: Motion = { ...motion };
                  if (to) next.to = to; else delete next.to;
                  onChange(next);
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

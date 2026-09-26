import { useState, useEffect } from 'react';
import type { ElementAnimKind } from '../../../core/types';
import type { InstallKind, InstallErrors } from '../../install';

/** 速度スライダーの対数変換。スライダーは 0..1000 の整数、速度は 0.1..16。 */
const SPEED_MIN = 0.1;
const SPEED_MAX = 16;
const LN_MIN = Math.log(SPEED_MIN);
const LN_MAX = Math.log(SPEED_MAX);
export function sliderToRate(slider: number): number {
  return Math.exp(LN_MIN + (LN_MAX - LN_MIN) * (slider / 1000));
}
export function rateToSlider(rate: number): number {
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate));
  return Math.round(((Math.log(clamped) - LN_MIN) / (LN_MAX - LN_MIN)) * 1000);
}

/** アニメ種別の選択肢。 */
const ANIM_KINDS: { value: ElementAnimKind; label: string }[] = [
  { value: 'none', label: 'なし' },
  { value: 'fade', label: 'フェード' },
  { value: 'zoom', label: 'ズーム' },
  { value: 'pop', label: 'ポップ' },
  { value: 'slideIn', label: 'スライドイン' },
];

/** 登場・退場アニメ選択 UI（種別セレクト＋長さスライダー）。 */
/**
 * 数値入力ボックス（スライダーと併用）。入力中はローカル文字列で保持し、Enter または
 * フォーカス外しで確定する（入力途中で値がスナップバックしない）。確定値は onCommit 側（op）
 * でクランプされるため、範囲外や空欄を打っても安全（数値でなければ元の表示へ戻す）。
 */
export function NumberField({
  id,
  value,
  min,
  max,
  step,
  decimals,
  suffix,
  className,
  selectAllOnFocus = false,
  onCommit,
}: {
  id?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  decimals: number;
  suffix?: string;
  className?: string;
  /** Signed numeric values can be replaced without leaving a minus sign behind. */
  selectAllOnFocus?: boolean;
  onCommit: (n: number) => void;
}) {
  const fmt = (v: number): string => v.toFixed(decimals);
  const [text, setText] = useState(() => fmt(value));
  const [focused, setFocused] = useState(false);
  // フォーカスしていないときだけ、外部（スライダー/リセット等）の値変化を表示へ反映する。
  useEffect(() => {
    if (!focused) setText(value.toFixed(decimals));
  }, [value, focused, decimals]);
  const commit = (): void => {
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n)) onCommit(n);
    else setText(fmt(value));
  };
  return (
    <span className="ins-num-field">
      <input
        id={id}
        className={className}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        onFocus={(event) => { setFocused(true); if (selectAllOnFocus) event.currentTarget.select(); }}
        onDoubleClick={(event) => { if (selectAllOnFocus) event.currentTarget.select(); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // blur owns the commit; committing here too creates two undo entries.
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      {suffix !== undefined ? <span className="ins-num-suffix">{suffix}</span> : null}
      {selectAllOnFocus && focused && (text.trim() === '' || Number(text) !== value) &&
        <small className="ins-num-pending" role="status">Enterで確定</small>}
    </span>
  );
}

export function AnimControls({
  idPrefix, label, value, onChange, defaultKind = 'fade',
}: {
  idPrefix: string;
  label: string;
  value: { kind: ElementAnimKind; frames: number } | undefined;
  onChange: (a: { kind: ElementAnimKind; frames: number }) => void;
  /** value 未指定時に表示する既定種別（画像＝'fade'、サブ動画＝'none'）。 */
  defaultKind?: ElementAnimKind;
}) {
  const kind = value?.kind ?? defaultKind;
  const frames = value?.frames ?? 8;
  return (
    <div className="ins-section">
      <div className="ins-label"><span>{label}</span></div>
      <select
        id={`${idPrefix}`}
        className="hl-input"
        value={kind}
        onChange={(e) => onChange({ kind: e.target.value as ElementAnimKind, frames })}
      >
        {ANIM_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
      </select>
      <div className="ins-label" style={{ marginTop: 6 }}><span>長さ {frames}fr</span></div>
      <input
        id={`${idPrefix}-frames`}
        type="range"
        min={2}
        max={30}
        step={1}
        value={frames}
        onChange={(e) => onChange({ kind, frames: Number(e.target.value) })}
      />
    </div>
  );
}

/**
 * 導入 CTA の共通部品（ボタン＋dirty ヒント＋自 kind のエラー表示）。
 * 「導入中…」ラベルとエラー表示は自分の kind のみ・disabled は全 kind 排他（導入は同時1件）
 * という規約を1箇所に固定し、CTA 追加時の kind 取り違え（残課題 #5 の再発）を構造的に防ぐ。
 */
export function InstallCtaButton({ kind, label, className, id, installing, installErrors, dirty, onInstall }: {
  kind: InstallKind;
  /** 非導入中のボタンラベル（導入中は「導入中…」に切り替わる）。 */
  label: string;
  className: string;
  id?: string;
  installing: InstallKind | null;
  installErrors: InstallErrors;
  dirty: boolean;
  onInstall: (kind: InstallKind) => void;
}) {
  return (
    <>
      <button
        type="button"
        id={id}
        className={'ins-pack-install ' + className}
        disabled={installing !== null || dirty}
        onClick={() => onInstall(kind)}
      >
        {installing === kind ? '導入中…' : label}
      </button>
      {dirty && <p className="ins-pack-hint">導入はプロジェクトを開き直すため、先に編集を保存してください。</p>}
      {installErrors[kind] && <p className="ins-pack-error">{installErrors[kind]}</p>}
    </>
  );
}

/** 音量プリセット（SE/BGM 共通の3段階）。 */
export const VOLUME_PRESETS: Array<{ label: string; value: number }> = [
  { label: '小', value: 0.2 },
  { label: '中', value: 0.5 },
  { label: '大', value: 0.85 },
];

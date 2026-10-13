import { useEffect, useId, useRef, useState } from 'react';
import type { ColorKnob, KnobSpec } from './knobs';

const COMMIT_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
const format = (value: number, spec: KnobSpec) => `${spec.step < 1 ? value.toFixed(2) : Math.round(value)}${spec.unit}`;

/** 名前と数値の行・スライダー・短い説明。数値のダブルクリックで初期値。離した時点で 1 回だけ確定する。 */
export function ThumbnailNumberKnob({ spec, value, disabled, onLive, onCommit }: { spec: KnobSpec; value: number; disabled: boolean; onLive(value: number): void; onCommit(value: number): void }) {
  const id = useId(), [draft, setDraft] = useState<number | null>(null), shown = draft ?? value;
  const commit = (next: number) => { setDraft(null); onCommit(Math.min(spec.max, Math.max(spec.min, next))); };
  return <div className="native-thumbnail-knob" data-knob={spec.id}>
    <label className="native-thumbnail-knob-label" htmlFor={id}><span>{spec.label}</span>
      <output title="ダブルクリックで初期値に戻す" onDoubleClick={() => { if (!disabled) commit(spec.initial); }}>{format(shown, spec)}</output></label>
    <input id={id} className="native-thumbnail-knob-range" type="range" min={spec.min} max={spec.max} step={spec.step} value={Math.min(spec.max, Math.max(spec.min, shown))} disabled={disabled}
      onChange={event => { const next = Number(event.target.value); setDraft(next); onLive(next); }}
      onPointerUp={event => commit(Number(event.currentTarget.value))}
      onKeyDown={event => event.stopPropagation()}
      onKeyUp={event => { if (COMMIT_KEYS.includes(event.key)) commit(Number(event.currentTarget.value)); }}
      onBlur={() => { if (draft !== null) commit(draft); }} />
    <p className="native-thumbnail-knob-hint">{spec.hint}</p>
  </div>;
}
/** 色は選んでいる間（input）は一時表示、選び終わり（change）で 1 回だけ確定する。 */
export function ThumbnailColorInput({ label, value, disabled, onLive, onCommit }: { label: string; value: string; disabled: boolean; onLive(value: string): void; onCommit(value: string): void }) {
  const input = useRef<HTMLInputElement>(null), latest = useRef(onCommit);
  latest.current = onCommit;
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const change = () => latest.current(element.value);
    element.addEventListener('change', change);
    return () => element.removeEventListener('change', change);
  }, []);
  return <input ref={input} type="color" className="native-thumbnail-color" aria-label={label} value={value} disabled={disabled}
    onInput={event => onLive(event.currentTarget.value)} onChange={() => undefined} />;
}
export function ThumbnailColorKnob({ knob, value, disabled, onLive, onCommit }: { knob: ColorKnob; value: string; disabled: boolean; onLive(value: string): void; onCommit(value: string): void }) {
  return <div className="native-thumbnail-knob" data-knob={knob.id}>
    <div className="native-thumbnail-knob-label"><span>{knob.label}</span><ThumbnailColorInput label={knob.label} value={value} disabled={disabled} onLive={onLive} onCommit={onCommit} /></div>
    <p className="native-thumbnail-knob-hint">{knob.hint}</p>
  </div>;
}

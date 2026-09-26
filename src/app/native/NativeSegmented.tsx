// src/app/native/NativeSegmented.tsx
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentItem<T extends string> { value: T; label: ReactNode; title?: string; key?: string; disabled?: boolean; controls?: string; tip?: string; shortcut?: string }

interface Props<T extends string> {
  /** 指示器の測り直しは value 変化・件数変化・host のリサイズで行う。件数を変えずにラベル（＝ボタン幅）だけ差し替える items を渡す場合は、value も変えるか key で remount すること。 */
  items: ReadonlyArray<SegmentItem<T>>;
  /** null はどのボタンも選択状態にしない（AI 表示中のタブ列。選択を偽装しないため）。 */
  value: T | null;
  onChange(value: T): void;
  /** aria-label。画面内で一意にする（「モード」「左パネル」「工具」など）。 */
  label: string;
  /** tablist＝パネルを切り替える／radiogroup＝排他の選択肢／group＝ナビ（aria-current=page）。 */
  role?: 'tablist' | 'radiogroup' | 'group';
  className?: string;
  disabled?: boolean;
}

/**
 * 「選択中」を下線で示すセグメント（UI 添削 F4: 画面内のタブ列を 1 種類に統一）。
 * - 指示器 <i> は選択ボタンの offsetLeft へ transform で移動する（幅は即時。動かすのは transform だけ）
 * - roving tabindex: 選択中だけ Tab 停止点。← → Home End で移動＝選択（WAI-ARIA tabs / radio パターン）
 * - 矢印キーは stopPropagation でワークスペースのコマ送りへ流さない
 */
export function NativeSegmented<T extends string>({ items, value, onChange, label, role = 'radiogroup', className = '', disabled = false }: Props<T>) {
  const root = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, top: 0, width: 0 });
  useLayoutEffect(() => {
    const host = root.current; if (!host) return;
    const measure = () => {
      const selected = host.querySelector<HTMLButtonElement>('button[data-selected=true]');
      if (!selected) { setIndicator(previous => previous.width === 0 ? previous : { left: 0, top: 0, width: 0 }); return; }
      // M-4: 折り返したとき（flex-wrap）は選択行の下へ縦にも動かす。指示器は bottom 固定なので
      //      「選択ボタンの下端 − コンテナの高さ」を Y のずれとして渡す（1 行なら 0）。
      const next = { left: selected.offsetLeft, top: selected.offsetTop + selected.offsetHeight - host.clientHeight, width: selected.offsetWidth };
      setIndicator(previous => previous.left === next.left && previous.top === next.top && previous.width === next.width ? previous : next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
    // 参照ではなく「測り直しが要る変化」だけを deps にする（items がインライン配列だと毎レンダー再生成される）。
  }, [value, items.length]);
  const enabled = items.filter(item => !item.disabled);
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = enabled.findIndex(item => item.value === value);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    // value===null（選択なし・AI 表示中）では停止点が先頭にあるので、矢印は端から動き出す。
    // index が -1 のまま回すと ArrowLeft が末尾の 1 つ手前へ飛ぶ（Task 8 Minor）。
    const from = index >= 0 ? index : step > 0 ? -1 : 0;
    const target = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled[enabled.length - 1] : step ? enabled[(from + step + enabled.length) % enabled.length] : undefined;
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    if (target.value !== value) onChange(target.value);
    root.current?.querySelector<HTMLButtonElement>(`button[data-value="${target.value}"]`)?.focus();
  };
  const tab = role === 'tablist', radio = role === 'radiogroup';
  // roving tabindex は複合ウィジェット（tablist / radiogroup）専用。group はナビ用の素のボタン列なので
  // 各ボタンを通常の Tab 停止点にする（既定の 0）。ここを選択中のみ 0 にすると非選択ボタンへ Tab で届かなくなる。
  const roving = tab || radio;
  return <div ref={root} className={`native-seg ${className}`.trim()} role={role} aria-label={label}>
    {items.map(item => {
      const selected = value !== null && item.value === value;
      // value===null（AI 表示中）では選択を偽装しない。roving tabindex の停止点だけ先頭へ置く。
      const stop = roving ? (value === null ? (item.value === enabled[0]?.value ? 0 : -1) : (selected ? 0 : -1)) : 0;
      return <button key={item.value} type="button" role={tab ? 'tab' : radio ? 'radio' : undefined} data-value={item.value}
        aria-selected={tab ? selected : undefined} aria-controls={tab ? item.controls : undefined} aria-checked={radio ? selected : undefined}
        aria-current={role === 'group' && selected ? 'page' : undefined} data-selected={selected} tabIndex={stop}
        // M-5: キー文字はアクセシブル名に混ぜない（「選択V」→「選択」）。キーは aria-keyshortcuts で伝える。
        aria-keyshortcuts={item.shortcut ?? item.key}
        title={item.tip ? undefined : item.title} data-tip={item.tip} disabled={disabled || item.disabled} onKeyDown={move} onClick={() => { if (!selected) onChange(item.value); }}>
        {item.label}{item.key && <kbd className="native-key" aria-hidden="true">{item.key}</kbd>}
      </button>;
    })}
    <i className="native-seg-indicator" aria-hidden="true" style={{ transform: `translate(${indicator.left}px, ${indicator.top}px)`, width: `${indicator.width}px` }} />
  </div>;
}

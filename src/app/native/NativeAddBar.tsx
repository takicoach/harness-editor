import {Icon} from '../Icon';
import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import {SHAPE_TOOLS} from './NativeShapeToolbar';
import type {ShapeKind} from '../../core/types';
import type {MaterialListTab} from './materialTab';
import {isEscape} from './keyboard';

export interface NativeAddBarProps {
  disabled: boolean;
  vertical?: boolean;
  onAddText(): void;
  onAddTitle(): void;
  onPickShape(kind: ShapeKind): void;
  onGoMaterials(tab: Exclude<MaterialListTab, 'video'>): void;
}

const MATERIAL_BUTTONS = [['image', '＋ 画像'], ['bgm', '＋ BGM'], ['se', '＋ 効果音']] as const;

/**
 * シーケンス道具バーの上に置く「内容の追加」の段（#4 = A 案）。
 *
 * 下段（`native-timeline-options`）は「トラックの追加」に役割を揃えるので、ここには入れない。
 * 素材 3 ボタンは**文書を変えない** — 該当タブへ切り替えて、既存の「再生位置に置く」を強調するだけ。
 *
 * `aria-label` は素材パネルの「作る」列から**そのまま移した**名前（T テキスト／タイトル／図形）。
 * 表示文字と食い違うが、既存監査のロケータを壊さないための意図的な選択（設計 C）。
 */
export function NativeAddBar({vertical=false,disabled, onAddText, onAddTitle, onPickShape, onGoMaterials}: NativeAddBarProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId(), host = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { if (open) host.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      const root = host.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (isEscape(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault(); event.stopPropagation();
    const items = [...(host.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
    const index = items.indexOf(window.document.activeElement as HTMLButtonElement);
    items[(index + step + items.length) % items.length]?.focus();
  };
  return <div className={`native-add-bar${vertical?' is-vertical':''}`} role="toolbar" aria-label="追加" aria-orientation={vertical?'vertical':'horizontal'}>
    <button type="button" className="btn-tonal" data-native-script-flush data-tutorial="add-telop" aria-label="T テキスト" title="テロップ" disabled={disabled} onClick={onAddText}><Icon name="type"/><span className="native-add-label">＋ テロップ</span></button>
    <button type="button" className="btn-tonal" data-native-script-flush aria-label="タイトル" title="タイトル" disabled={disabled} onClick={onAddTitle}><Icon name="captions"/><span className="native-add-label">＋ タイトル</span></button>
    <div className="native-add-menu" ref={host} onKeyDown={keys}>
      <button ref={trigger} type="button" className="btn-tonal" data-native-script-flush aria-label="図形" title="図形（プレビュー上で描く）"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}><Icon name="shapes"/><span className="native-add-label">＋ 図形</span></button>
      {open && <div className="native-add-menu-list" id={menuId} role="menu" aria-label="図形の種類">
        {SHAPE_TOOLS.map(tool => <button key={tool.kind} type="button" role="menuitem" className="native-add-menu-item"
          onClick={() => { setOpen(false); onPickShape(tool.kind); trigger.current?.focus(); }}>{tool.label}</button>)}
      </div>}
    </div>
    {MATERIAL_BUTTONS.map(([value, label]) => <button key={value} type="button" className="btn-tonal" aria-label={label} disabled={disabled}
      onClick={() => onGoMaterials(value)}><Icon name={value==='image'?'image':value==='bgm'?'music':'volume'}/><span className="native-add-label">{label}</span></button>)}
  </div>;
}

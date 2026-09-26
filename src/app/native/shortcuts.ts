import type { NativeTool } from './NativeTimeline';
import { isEscape } from './keyboard';

export type ShortcutId = 'play-toggle' | 'shuttle' | 'frame-step' | 'jump-edge' | 'save' | 'undo' | 'split' | 'delete' | 'escape' | 'tool-select' | 'tool-razor' | 'tool-range' | 'snap' | 'ripple' | 'help';
export interface Shortcut { id: ShortcutId; keys: string[]; label: string; group: '再生' | '編集' | '工具' | '表示'; tool?: NativeTool; match(event: KeyboardEvent): boolean }

const mod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
const plain = (e: KeyboardEvent, key: string) => !mod(e) && e.key.toLowerCase() === key;

/**
 * ショートカットの正本（登録表に一本化する）。NativeWorkspace の keydown は matchShortcut() の id で分岐し、
 * フッターと `?` ダイアログはこの表から描く。増やすときはここへ 1 件足し、keydown の switch に 1 case 足す。
 */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'play-toggle', keys: ['Space'], label: '再生 / 停止', group: '再生', match: e => e.code === 'Space' },
  { id: 'shuttle', keys: ['J', 'K', 'L'], label: '逆再生 / 停止 / 順再生（連打で 2・4・8 倍。K を押しながら J / L で 1 コマ送り、⇧ でスロー）', group: '再生', match: e => plain(e, 'j') || plain(e, 'k') || plain(e, 'l') },
  { id: 'frame-step', keys: ['←', '→'], label: '1 コマ移動（⇧ で 10 コマ）', group: '再生', match: e => e.key === 'ArrowLeft' || e.key === 'ArrowRight' },
  { id: 'jump-edge', keys: ['Home', 'End'], label: '先頭 / 末尾へ', group: '再生', match: e => e.key === 'Home' || e.key === 'End' },
  { id: 'tool-select', keys: ['V'], label: '選択', group: '工具', tool: 'select', match: e => plain(e, 'v') },
  { id: 'tool-razor', keys: ['C'], label: '分割', group: '工具', tool: 'razor', match: e => plain(e, 'c') },
  { id: 'tool-range', keys: ['B'], label: 'なぞってカット', group: '工具', tool: 'range', match: e => plain(e, 'b') },
  { id: 'snap', keys: ['S'], label: 'スナップ', group: '工具', match: e => plain(e, 's') },
  { id: 'ripple', keys: ['R'], label: '詰める（端を短くした範囲を全トラックから取り除く）', group: '工具', match: e => plain(e, 'r') },
  { id: 'split', keys: ['⌘/Ctrl', 'K'], label: '再生位置で分割', group: '編集', match: e => mod(e) && e.key.toLowerCase() === 'k' },
  { id: 'delete', keys: ['Delete'], label: '選択範囲をカット / クリップを削除', group: '編集', match: e => e.key === 'Delete' || e.key === 'Backspace' },
  { id: 'escape', keys: ['Esc'], label: '選択を解除', group: '編集', match: e => isEscape(e) },
  { id: 'undo', keys: ['⌘/Ctrl', 'Z'], label: '元に戻す（⇧ でやり直す）', group: '編集', match: e => mod(e) && e.key.toLowerCase() === 'z' },
  { id: 'save', keys: ['⌘/Ctrl', 'S'], label: '保存', group: '編集', match: e => mod(e) && e.key.toLowerCase() === 's' },
  { id: 'help', keys: ['?'], label: 'ショートカット一覧', group: '表示', match: e => e.key === '?' },
];

export function matchShortcut(event: KeyboardEvent): ShortcutId | null {
  return SHORTCUTS.find(s => s.match(event))?.id ?? null;
}

/** フッターの文脈ヒント。範囲選択中はカットと解除だけ、それ以外は再生 2 件・他の工具・再生位置で分割。 */
export function footerHints(tool: NativeTool, rangeActive: boolean): Shortcut[] {
  if (rangeActive) return SHORTCUTS.filter(s => s.id === 'delete' || s.id === 'escape');
  const play = SHORTCUTS.filter(s => s.id === 'play-toggle' || s.id === 'shuttle');
  const tools = SHORTCUTS.filter(s => s.tool && s.tool !== tool);
  const split = SHORTCUTS.filter(s => s.id === 'split');
  return [...play, ...tools, ...split];
}

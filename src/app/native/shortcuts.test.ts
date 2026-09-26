/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { SHORTCUTS, footerHints, matchShortcut, type ShortcutId } from './shortcuts';

describe('ショートカット表', () => {
  it('キーと説明が空でなく、説明は重複しない', () => {
    const labels = SHORTCUTS.map(s => s.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const s of SHORTCUTS) { expect(s.keys.length).toBeGreaterThan(0); expect(s.label.length).toBeGreaterThan(0); }
  });
  it('工具のキー V / C / B と再生の J K L・Space を含む（要素一致。部分文字列一致だと S⊂Space 等で消えても緑になる）', () => {
    const flat = SHORTCUTS.flatMap(s => s.keys);
    for (const k of ['V', 'C', 'B', 'S', 'J', 'K', 'L', 'Space', '?']) expect(flat).toContain(k);
  });

  const ev = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  const table: Record<ShortcutId, KeyboardEventInit[]> = {
    'play-toggle': [{ code: 'Space', key: ' ' }],
    'shuttle': [{ key: 'j' }, { key: 'k' }, { key: 'l' }],
    'frame-step': [{ key: 'ArrowLeft' }, { key: 'ArrowRight' }],
    'jump-edge': [{ key: 'Home' }, { key: 'End' }],
    'tool-select': [{ key: 'v' }],
    'tool-razor': [{ key: 'c' }],
    'tool-range': [{ key: 'b' }],
    'snap': [{ key: 's' }],
    'ripple': [{ key: 'r' }],
    'split': [{ key: 'k', metaKey: true }, { key: 'k', ctrlKey: true }],
    'delete': [{ key: 'Delete' }, { key: 'Backspace' }],
    'escape': [{ key: 'Escape' }],
    'undo': [{ key: 'z', metaKey: true }, { key: 'z', metaKey: true, shiftKey: true }],
    'save': [{ key: 's', metaKey: true }],
    'help': [{ key: '?' }],
  };

  it('SHORTCUTS の全 id がテスト表に登場する（表からの漏れを検出）', () => {
    const ids = new Set(SHORTCUTS.map(s => s.id));
    expect([...ids].sort()).toEqual(Object.keys(table).sort());
  });

  it.each(Object.entries(table).flatMap(([id, inits]) => inits.map(init => [id, init] as const)))(
    'matchShortcut(%o) -> %s',
    (id, init) => { expect(matchShortcut(ev(init))).toBe(id); },
  );

  it('分離: 素の k は shuttle であり split ではない、素の s は snap であり save ではない、未知キーは null', () => {
    expect(matchShortcut(ev({ key: 'k' }))).toBe('shuttle');
    expect(matchShortcut(ev({ key: 'k' }))).not.toBe('split');
    expect(matchShortcut(ev({ key: 's' }))).toBe('snap');
    expect(matchShortcut(ev({ key: 's' }))).not.toBe('save');
    expect(matchShortcut(ev({ key: 'x' }))).toBeNull();
  });
  it('フッターは選択中の工具を除いた工具キーと再生キーを出す', () => {
    const hints = footerHints('select', false);
    const keys = hints.flatMap(h => h.keys);
    expect(keys).not.toContain('V'); expect(keys).toContain('C'); expect(keys).toContain('B'); expect(keys).toContain('Space');
  });
  it('範囲選択中は Delete と Esc だけを出す', () => {
    expect(footerHints('range', true).map(h => h.keys[0])).toEqual(['Delete', 'Esc']);
  });
});

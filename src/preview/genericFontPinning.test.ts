// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { GENERIC_FONT_PINS, pinGenericFonts } from './genericFontPinning';

afterEach(() => { document.body.replaceChildren(); });

function environment() {
  const frame = document.createElement('iframe'); document.body.append(frame);
  const doc = frame.contentDocument!;
  const root = doc.createElement('div'); doc.body.append(root);
  return { root, doc };
}
function text(root: Element, family: string | null, weight = '800', content = '00 全体像 難しい理由') {
  const span = root.ownerDocument.createElement('span'); span.textContent = content;
  if (family !== null) span.style.fontFamily = family;
  span.style.fontWeight = weight; span.style.color = 'red';
  root.append(span); return span;
}

it('puts the bundled sans face before a leading generic family and restores the authored DOM exactly', () => {
  const { root } = environment(); const node = text(root, 'sans-serif'); const before = node.outerHTML;
  const cleanup = pinGenericFonts(root);
  expect(node.style.fontFamily).toBe('"Noto Sans JP", sans-serif');
  expect(node.style.fontWeight).toBe('800'); expect(node.style.color).toBe('red');
  cleanup(); expect(node.outerHTML).toBe(before);
});

it('maps every pinned generic family to a bundled face and leaves other lists untouched', () => {
  const { root } = environment();
  const pinned: Array<[string, string]> = [
    ['serif', '"Noto Serif JP", serif'], ['system-ui', '"Noto Sans JP", system-ui'], ['ui-sans-serif', '"Noto Sans JP", ui-sans-serif'],
    ['ui-serif', '"Noto Serif JP", ui-serif'], ['ui-rounded', '"Noto Sans JP", ui-rounded'], ['SANS-SERIF', '"Noto Sans JP", sans-serif'],
    ['sans-serif, serif', '"Noto Sans JP", sans-serif, serif'],
  ];
  const untouched = ['monospace', 'cursive', 'fantasy', 'Arial, sans-serif', '"Noto Sans JP", sans-serif', '"Hiragino Sans", serif', 'Helvetica'];
  const nodes = pinned.map(([family]) => text(root, family)), others = untouched.map(family => text(root, family));
  const before = others.map(node => node.outerHTML);
  const cleanup = pinGenericFonts(root);
  // 総称の残りは computed の綴りをそのまま保つ（実ブラウザは小文字、jsdom は書いたまま）。意味は同じなので大小は問わない。
  for (const [index, [, expected]] of pinned.entries()) expect(nodes[index]!.style.fontFamily.toLowerCase()).toBe(expected.toLowerCase());
  expect(others.map(node => node.outerHTML)).toEqual(before);
  cleanup();
  for (const [index, [family]] of pinned.entries()) expect(nodes[index]!.style.fontFamily).toBe(family);
  expect(Object.keys(GENERIC_FONT_PINS).sort()).toEqual(['fangsong', 'sans-serif', 'serif', 'system-ui', 'ui-rounded', 'ui-sans-serif', 'ui-serif']);
});

it('keeps the authored priority, skips style and script elements, and ignores elements without text or an own family', () => {
  const { root, doc } = environment();
  const important = text(root, 'sans-serif'); important.style.setProperty('font-family', 'sans-serif', 'important');
  const style = doc.createElement('style'); style.textContent = '.x{font-family:sans-serif}'; root.append(style);
  const empty = doc.createElement('div'); empty.style.fontFamily = ''; root.append(empty);
  const styleBefore = style.outerHTML, emptyBefore = empty.outerHTML;
  const cleanup = pinGenericFonts(root);
  expect(important.style.getPropertyValue('font-family')).toBe('"Noto Sans JP", sans-serif');
  expect(important.style.getPropertyPriority('font-family')).toBe('important');
  expect(style.outerHTML).toBe(styleBefore); expect(empty.outerHTML).toBe(emptyBefore);
  cleanup();
  expect(important.style.getPropertyValue('font-family')).toBe('sans-serif');
  expect(important.style.getPropertyPriority('font-family')).toBe('important');
});

it('removes an inline style it created and never undoes a later edit by someone else', () => {
  const { root, doc } = environment();
  const bare = doc.createElement('span'); bare.textContent = 'ABC'; bare.setAttribute('style', 'font-family: serif'); root.append(bare);
  const owned = doc.createElement('span'); owned.textContent = 'DEF'; root.append(owned);
  // 継承で総称になる要素は、自分の style が無くても対象（computed で判定する）。
  root.style.fontFamily = 'sans-serif';
  const cleanup = pinGenericFonts(root);
  expect(bare.style.fontFamily).toBe('"Noto Serif JP", serif');
  expect(root.style.fontFamily).toBe('"Noto Sans JP", sans-serif');
  bare.style.fontFamily = 'Arial';
  cleanup();
  expect(bare.style.fontFamily).toBe('Arial');
  expect(root.style.fontFamily).toBe('sans-serif');
  expect(owned.hasAttribute('style')).toBe(false);
});

it('does nothing without a window', () => {
  const root = document.implementation.createHTMLDocument('').createElement('div');
  expect(typeof pinGenericFonts(root)).toBe('function');
});

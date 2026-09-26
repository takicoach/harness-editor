/**
 * R-6 / R-7 の回帰固定: ライトテーマの影トークンと波形色トークンが
 * :root（ダーク既定）と [data-theme="light"] とで実際に別値へ出し分けられていることを
 * styles.css のテキストから直接検証する（ビルド後の computed style ではなく
 * ソース上のトークン定義そのものを固定する低コストな回帰）。
 *
 * R-6: ライトテーマの box-shadow がダークの黒系ハードコード
 *      （rgba(0, 0, 0, α)）のままだと、白い面で影が濁って浮く。
 *      :root[data-theme="light"] 側は背景になじむ低彩度のgreen-neutralを使う。
 * R-7: 波形色（--wave-rms / --wave-peak）がテーマ共通の中間色に固定されていると
 *      片テーマで背景に埋もれる。ダーク/ライトで別値を持ち、各テーマの背景
 *      （--bg-2 相当のトラック面）との輝度差が十分であることを固定する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS_PATH = join(__dirname, 'styles.css');
const css = readFileSync(CSS_PATH, 'utf8');

/** `:root { ... }`（data-theme 修飾なしの最初のブロック）の中身を取り出す。 */
function extractRootBlock(source: string): string {
  const m = source.match(/(?<!\[data-theme="light"\]\s*)\n:root\s*\{([\s\S]*?)\n\}/);
  if (m === null || m[1] === undefined) throw new Error(':root ブロックが見つからない');
  return m[1];
}

/** `:root[data-theme="light"] { ... }` の中身を取り出す。 */
function extractLightBlock(source: string): string {
  const m = source.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);
  if (m === null || m[1] === undefined) throw new Error(':root[data-theme="light"] ブロックが見つからない');
  return m[1];
}

function readVar(block: string, name: string): string {
  // 最初の `--name:` 定義を拾う（同一ブロック内での再宣言は想定しない）。
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  const m = block.match(re);
  if (m === null || m[1] === undefined) throw new Error(`--${name} が見つからない`);
  return m[1].trim();
}

/** `rgba(r, g, b, a)` / `rgb(r, g, b)` / `#RRGGBB` を [r,g,b,a] へ。 */
function parseRgba(value: string): [number, number, number, number] {
  const hex = value.match(/#([0-9a-fA-F]{6})\b/);
  if (hex !== null && hex[1] !== undefined) {
    const n = hex[1];
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), 1];
  }
  const m = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (m === null) throw new Error(`rgba() として解釈できない: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

/** sRGB 相対輝度（WCAG 式の簡易版・0..1）。 */
function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** rgba(fg) を rgb(bg) の上に重ねた見かけ色。 */
function overOpaque(fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] {
  const [r, g, b, a] = fg;
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
}

const root = extractRootBlock(css);
const light = extractLightBlock(css);

describe('R-6: ライトテーマの影トークン（green-neutral化）', () => {
  const shadowTokens = ['shadow-chip', 'shadow-clip', 'shadow-fab', 'shadow-pop'];

  it.each(shadowTokens)('%s はダーク既定と別値を持つ（トークンが実際に切り替わる）', (token) => {
    const darkValue = readVar(root, token);
    const lightValue = readVar(light, token);
    expect(lightValue).not.toBe(darkValue);
  });

  it.each(shadowTokens)('%s のライト値はgreen-neutralで黒系のままではない', (token) => {
    const lightValue = readVar(light, token);
    // box-shadow の値末尾に rgba(...) が入っている想定。
    const [r, g, b] = parseRgba(lightValue);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});

describe('R-7: 波形色トークン（テーマ別出し分け・コントラスト）', () => {
  it('--wave-rms はダークとライトで別値を持つ', () => {
    expect(readVar(light, 'wave-rms')).not.toBe(readVar(root, 'wave-rms'));
  });
  it('--wave-peak はダークとライトで別値を持つ', () => {
    expect(readVar(light, 'wave-peak')).not.toBe(readVar(root, 'wave-peak'));
  });

  it('ダーク: --wave-rms はトラック背景（--bg-2）から埋もれない程度に分離する', () => {
    const bg = parseRgba(`rgba(${[0x23, 0x29, 0x27].join(',')},1)`);
    const rms = parseRgba(readVar(root, 'wave-rms'));
    const composited = overOpaque(rms, [bg[0], bg[1], bg[2]]);
    const ratio = contrastRatio(
      relativeLuminance(...composited),
      relativeLuminance(bg[0], bg[1], bg[2]),
    );
    expect(ratio).toBeGreaterThan(1.3);
  });

  it('ライト: --wave-rms はトラック背景（--bg-2）から埋もれない程度に分離する', () => {
    const bg = parseRgba(`rgba(${[0xed, 0xf0, 0xee].join(',')},1)`);
    const rms = parseRgba(readVar(light, 'wave-rms'));
    const composited = overOpaque(rms, [bg[0], bg[1], bg[2]]);
    const ratio = contrastRatio(
      relativeLuminance(...composited),
      relativeLuminance(bg[0], bg[1], bg[2]),
    );
    expect(ratio).toBeGreaterThan(1.3);
  });
});

describe('R-8: 文字トークンは両テーマで AA（4.5:1）を満たす', () => {
  // --fg-3 は最小段だが .native-key / .native-asset-meta / .native-hint など
  // 装飾ではなく情報テキストに使う。地は styles.css の実値（--bg-1 / --bg-2）を読む。
  it.each([['fg-2'], ['fg-3']])('%s は両テーマの --bg-1 / --bg-2 で 4.5:1 以上', (name) => {
    for (const [theme, block] of [['dark', root], ['light', light]] as const) {
      const fg = parseRgba(readVar(block, name));
      for (const bgName of ['bg-1', 'bg-2'] as const) {
        const [br, bg_, bb] = parseRgba(readVar(block, bgName));
        const composited = overOpaque(fg, [br, bg_, bb]);
        const ratio = contrastRatio(relativeLuminance(...composited), relativeLuminance(br, bg_, bb));
        expect(ratio, `${theme} --${name} on --${bgName}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

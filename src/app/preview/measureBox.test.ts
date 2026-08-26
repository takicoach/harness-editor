/**
 * @vitest-environment jsdom
 *
 * 実測枠の純関数（矩形合併・除外規則・座標変換・0.5px 量子化・オンデマンド測定）のテスト。
 *
 * jsdom の getBoundingClientRect は常に全ゼロなので、矩形は RectReader（差し替え可能な
 * 読み取り関数）で注入する。DOM の走査そのもの（子孫列挙・leaf 判定）は実 DOM で見る。
 */
import { describe, it, expect } from 'vitest';
import {
  measureItemRect,
  measureTelopHits,
  findMeasureRoot,
  findMeasureItem,
  quantize,
  isReplacedElement,
  hasOwnText,
  isPaintedBox,
  type RectLike,
  type RectReader,
} from './measureBox';

/** 全画面（= data-sme-root）の client 矩形。 */
const FRAME: RectLike = { left: 100, top: 50, width: 400, height: 800 };
/** stage（overlay root）の client 矩形。content はこの中に収まる。 */
const ORIGIN: RectLike = { left: 80, top: 40, width: 440, height: 820 };

/** 要素 → 矩形の対応表から RectReader を作る（未登録は全ゼロ＝寸法ゼロ扱い）。 */
function readerOf(map: Map<Element, RectLike>): RectReader {
  return (el) => map.get(el) ?? { left: 0, top: 0, width: 0, height: 0 };
}

/** タグを作って親へ足し、矩形を登録する。 */
function add(
  map: Map<Element, RectLike>,
  parent: Element,
  tag: string,
  rect: RectLike | null,
  opts: { text?: string; background?: string } = {},
): Element {
  const el = parent.ownerDocument.createElement(tag);
  parent.appendChild(el);
  if (rect !== null) map.set(el, rect);
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.background !== undefined) (el as HTMLElement).style.background = opts.background;
  return el;
}

/** 測定ルートと1件のラッパーを持つ最小 DOM を作る。 */
function makeRoot(): { root: HTMLElement; map: Map<Element, RectLike> } {
  const root = document.createElement('div');
  root.setAttribute('data-sme-root', '');
  const map = new Map<Element, RectLike>();
  map.set(root, FRAME);
  return { root, map };
}

function wrapperIn(root: HTMLElement, kind: string, id: number): HTMLElement {
  const w = document.createElement('div');
  w.setAttribute('data-sme-kind', kind);
  w.setAttribute('data-sme-id', String(id));
  root.appendChild(w);
  return w;
}

describe('quantize', () => {
  it('0.5px 単位へ丸める', () => {
    expect(quantize(10.24)).toBe(10);
    expect(quantize(10.26)).toBe(10.5);
    expect(quantize(-3.3)).toBe(-3.5);
  });
});

describe('合併規則 v2 の述語', () => {
  it('isReplacedElement: IMG/VIDEO/CANVAS/SVG は子の有無に関わらず true', () => {
    expect(isReplacedElement(document.createElement('img'))).toBe(true);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'line'));
    expect(isReplacedElement(svg)).toBe(true);
    expect(isReplacedElement(document.createElement('div'))).toBe(false);
  });

  it('hasOwnText: 子要素を持たずテキストがあるときだけ true', () => {
    const span = document.createElement('span');
    span.textContent = 'テロップ';
    expect(hasOwnText(span)).toBe(true);
    const blank = document.createElement('span');
    blank.textContent = '   ';
    expect(hasOwnText(blank)).toBe(false);
    const parent = document.createElement('div');
    parent.textContent = 'あ';
    parent.appendChild(document.createElement('span'));
    expect(hasOwnText(parent)).toBe(false);
  });

  it('isPaintedBox: 背景色・border・box-shadow・背景画像のいずれかで true', () => {
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    expect(isPaintedBox(plain)).toBe(false);

    const bg = document.createElement('div');
    bg.style.background = 'rgba(0, 0, 0, 0.55)';
    document.body.appendChild(bg);
    expect(isPaintedBox(bg)).toBe(true);

    const clear = document.createElement('div');
    clear.style.background = 'rgba(0, 0, 0, 0)';
    document.body.appendChild(clear);
    expect(isPaintedBox(clear)).toBe(false);

    const bordered = document.createElement('div');
    bordered.style.border = '2px solid #FF3B30';
    document.body.appendChild(bordered);
    expect(isPaintedBox(bordered)).toBe(true);

    const shadowed = document.createElement('div');
    shadowed.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';
    document.body.appendChild(shadowed);
    expect(isPaintedBox(shadowed)).toBe(true);

    for (const el of [plain, bg, clear, bordered, shadowed]) el.remove();
  });
});

describe('measureItemRect', () => {
  it('全画面同寸でも置換要素（img）は合併に含める', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'image', 1);
    add(map, w, 'img', { left: 100, top: 50, width: 400, height: 800 });

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    // stage ローカル = client - origin。
    expect(r).toEqual({ x: 20, y: 10, w: 400, h: 800 });
  });

  it('子を持つコンテナの全画面同寸は除外し、実描画の子孫だけを合併する', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'telop', 3);
    // 中間 AbsoluteFill（全画面・子あり）→ 除外。その中のテキスト行だけが実描画。
    const mid = add(map, w, 'div', { left: 100, top: 50, width: 400, height: 800 });
    add(map, mid, 'span', { left: 150, top: 600, width: 200, height: 60 }, { text: 'あ' });

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(r).toEqual({ x: 70, y: 560, w: 200, h: 60 });
  });

  it('複数の子孫矩形を合併（union）する', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'telop', 3);
    const mid = add(map, w, 'div', { left: 100, top: 50, width: 400, height: 800 });
    add(map, mid, 'span', { left: 150, top: 600, width: 100, height: 40 }, { text: 'あ' });
    add(map, mid, 'span', { left: 300, top: 620, width: 100, height: 60 }, { text: 'い' });

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    // union: left 150..400 / top 600..680 → stage ローカルへ変換。
    expect(r).toEqual({ x: 70, y: 560, w: 250, h: 80 });
  });

  it('寸法ゼロの要素はスキップする（display:none 等）', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'telop', 3);
    add(map, w, 'div', { left: 0, top: 0, width: 0, height: 0 }, { text: '消えた行' });
    add(map, w, 'span', { left: 150, top: 600, width: 100, height: 40 }, { text: 'あ' });

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(r).toEqual({ x: 70, y: 560, w: 100, h: 40 });
  });

  it('opacity:0 の要素も合併に含める（フェード中も枠を出す）', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'telop', 3);
    const el = add(map, w, 'span', { left: 150, top: 600, width: 100, height: 40 }, { text: 'あ' });
    (el as HTMLElement).style.opacity = '0';

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(r).toEqual({ x: 70, y: 560, w: 100, h: 40 });
  });

  it('結果は 0.5px 単位へ量子化される', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'telop', 3);
    add(map, w, 'span', { left: 150.24, top: 600.26, width: 100.1, height: 40.4 }, { text: 'あ' });

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    // 4 辺を量子化してから幅・高さを引く（幅を丸めると隣接枠が食い違うため辺で丸める）。
    // left 70.24→70 / top 560.26→560.5 / right 170.34→170.5 / bottom 600.66→600.5
    expect(r).toEqual({ x: 70, y: 560.5, w: 100.5, h: 40 });
  });

  it('実描画の子孫が 1 つも無ければ null（＝フォールバックへ）', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'telop', 3);
    add(map, w, 'div', null); // 矩形未登録＝全ゼロ

    expect(measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) })).toBeNull();
  });

  it('ラッパー自身（全画面）は合併に含めない', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'videoInsert', 2);
    map.set(w, FRAME);
    add(map, w, 'video', { left: 200, top: 300, width: 100, height: 100 });

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(r).toEqual({ x: 120, y: 260, w: 100, h: 100 });
  });
});

describe('合併規則 v2 — 見えているものだけを測る', () => {
  it('全幅の透明なレイアウトラッパーは寸法によらず除外し、テキストの幅で合併する', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'telop', 3);
    // 字幕の行ラッパー（left:0/right:0・背景なし）。これを拾うと枠がフレーム全幅へ広がる。
    const line = add(map, w, 'div', { left: 100, top: 600, width: 400, height: 80 });
    const span = add(map, line, 'span', { left: 180, top: 605, width: 160, height: 70 });
    span.textContent = 'ゆる素振り';

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(r).toEqual({ x: 100, y: 565, w: 160, h: 70 });
  });

  it('塗られた非全画面のコンテナ（カード）は含める', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'telop', 3);
    const card = add(map, w, 'div', { left: 140, top: 560, width: 220, height: 120 }, {
      background: 'rgba(255, 255, 255, 1)',
    });
    add(map, card, 'span', { left: 160, top: 600, width: 100, height: 40 }, { text: 'あ' });

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(r).toEqual({ x: 60, y: 520, w: 220, h: 120 });
  });

  it('塗りもテキストも無い leaf は描画物ではないので含めない', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'telop', 3);
    add(map, w, 'div', { left: 150, top: 600, width: 100, height: 40 }); // 無地・無テキスト
    add(map, w, 'span', { left: 200, top: 700, width: 60, height: 30 }, { text: 'あ' });

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(r).toEqual({ x: 120, y: 660, w: 60, h: 30 });
  });

  it('overlay 型の暗幕（全画面の塗り）は除外し、カード画像の実寸で合併する', () => {
    const { root, map } = makeRoot();
    const w = wrapperIn(root, 'image', 5);
    const scrim = add(map, w, 'div', { left: 100, top: 50, width: 400, height: 800 });
    (scrim as HTMLElement).style.background = 'rgba(0, 0, 0, 0.4)';
    const holder = add(map, scrim, 'div', { left: 100, top: 50, width: 400, height: 800 });
    add(map, holder, 'img', { left: 150, top: 300, width: 300, height: 200 });

    const r = measureItemRect(w, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(r).toEqual({ x: 70, y: 260, w: 300, h: 200 });
  });
});

describe('measureTelopHits', () => {
  it('telop ラッパーだけを DOM 順に測定して id 付きで返す', () => {
    const { root, map } = makeRoot();
    const t1 = wrapperIn(root, 'telop', 11);
    add(map, t1, 'span', { left: 150, top: 600, width: 100, height: 40 }, { text: 'あ' });
    const img = wrapperIn(root, 'image', 5);
    add(map, img, 'img', { left: 100, top: 50, width: 400, height: 800 });
    const t2 = wrapperIn(root, 'telop', 12);
    add(map, t2, 'span', { left: 160, top: 700, width: 120, height: 50 }, { text: 'い' });

    const hits = measureTelopHits(root, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(hits.map((h) => h.id)).toEqual([11, 12]);
    expect(hits[0]!.rect).toEqual({ x: 70, y: 560, w: 100, h: 40 });
  });

  it('測定できないテロップは結果に含めない（呼び出し側が従来式で補う）', () => {
    const { root, map } = makeRoot();
    const t1 = wrapperIn(root, 'telop', 11);
    add(map, t1, 'span', null, { text: 'あ' }); // 全ゼロ＝測定不能
    const t2 = wrapperIn(root, 'telop', 12);
    add(map, t2, 'span', { left: 160, top: 700, width: 120, height: 50 }, { text: 'い' });

    const hits = measureTelopHits(root, { frame: FRAME, origin: ORIGIN, read: readerOf(map) });
    expect(hits.map((h) => h.id)).toEqual([12]);
  });

  it('root が null なら空配列（例外を投げない）', () => {
    expect(measureTelopHits(null, { frame: FRAME, origin: ORIGIN })).toEqual([]);
  });
});

describe('findMeasureRoot / findMeasureItem', () => {
  it('スコープ配下の data-sme-root と対象ラッパーだけを引く', () => {
    const stage = document.createElement('div');
    const { root } = makeRoot();
    stage.appendChild(root);
    wrapperIn(root, 'telop', 7);

    expect(findMeasureRoot(stage)).toBe(root);
    expect(findMeasureItem(root, 'telop', 7)).not.toBeNull();
    expect(findMeasureItem(root, 'telop', 8)).toBeNull();
    expect(findMeasureItem(root, 'image', 7)).toBeNull();
    expect(findMeasureRoot(null)).toBeNull();
  });

  it('スコープ外（別 Player・document 全域）の data-sme-root は拾わない', () => {
    const other = document.createElement('div');
    other.setAttribute('data-sme-root', '');
    document.body.appendChild(other);
    const stage = document.createElement('div');
    document.body.appendChild(stage);
    try {
      expect(findMeasureRoot(stage)).toBeNull();
    } finally {
      other.remove();
      stage.remove();
    }
  });
});

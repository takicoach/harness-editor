/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { locateUsableTarget, readDialogState, usableRect } from './nativeTutorialDom';

type Box = { left: number; top: number; width: number; height: number };
function place(html: string): void {
  document.body.innerHTML = html;
}
function box(el: Element, b: Box): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ ...b, right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top, toJSON: () => ({}) }),
  });
}
function hitTest(fn: (x: number, y: number) => Element | null) {
  const spy = vi.fn(fn);
  Object.defineProperty(document, 'elementFromPoint', { value: spy, configurable: true });
  return spy;
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (document as unknown as Record<string, unknown>)['elementFromPoint'];
});

describe('usableRect（見えて押せるか）', () => {
  it('見えていて中心が自分に当たれば矩形を返す（中心で当たり判定をしたことも確かめる）', () => {
    place('<button id="t">x</button>');
    const el = document.getElementById('t')!;
    box(el, { left: 100, top: 50, width: 80, height: 40 });
    const spy = hitTest(() => el);
    expect(usableRect(el)).toEqual({ left: 100, top: 50, right: 180, bottom: 90, width: 80, height: 40 });
    expect(spy).toHaveBeenCalledWith(140, 70);
  });
  it('祖先に hidden 属性があれば見えない（子の computed display は none にならないので祖先をたどる）', () => {
    place('<div hidden><button id="t">x</button></div>');
    const el = document.getElementById('t')!;
    box(el, { left: 0, top: 0, width: 10, height: 10 });
    hitTest(() => el);
    expect(getComputedStyle(el).display).not.toBe('none');
    expect(usableRect(el)).toBeNull();
  });
  it('祖先が display:none なら見えない', () => {
    place('<section style="display:none"><button id="t">x</button></section>');
    const el = document.getElementById('t')!;
    box(el, { left: 0, top: 0, width: 10, height: 10 });
    hitTest(() => el);
    expect(usableRect(el)).toBeNull();
  });
  it('visibility:hidden は見えない', () => {
    place('<button id="t" style="visibility:hidden">x</button>');
    const el = document.getElementById('t')!;
    box(el, { left: 0, top: 0, width: 10, height: 10 });
    hitTest(() => el);
    expect(usableRect(el)).toBeNull();
  });
  it('幅・高さ 0 は見えない', () => {
    place('<button id="t">x</button>');
    const el = document.getElementById('t')!;
    box(el, { left: 10, top: 10, width: 0, height: 20 });
    hitTest(() => el);
    expect(usableRect(el)).toBeNull();
  });
  it('画面外は見えない', () => {
    place('<button id="t">x</button>');
    const el = document.getElementById('t')!;
    box(el, { left: window.innerWidth + 5, top: 10, width: 20, height: 20 });
    hitTest(() => el);
    expect(usableRect(el)).toBeNull();
  });
  it('画面より大きい対象は、見えている部分の中心で当たり判定する（作品一覧が長い場合）', () => {
    place('<div id="t"></div>');
    const el = document.getElementById('t')!;
    box(el, { left: 0, top: 100, width: 200, height: 2000 });
    const spy = hitTest(() => el);
    expect(usableRect(el)).not.toBeNull();
    expect(spy).toHaveBeenCalledWith(100, (100 + window.innerHeight) / 2);
  });
  it('中心が別の要素に遮られていれば押せない', () => {
    place('<button id="t">x</button><div id="cover"></div>');
    const el = document.getElementById('t')!;
    box(el, { left: 10, top: 10, width: 20, height: 20 });
    const spy = hitTest(() => document.getElementById('cover'));
    expect(usableRect(el)).toBeNull();
    expect(spy).toHaveBeenCalled();
  });
  it('自分の吹き出し（.tut の中）に当たるのは遮蔽に数えない', () => {
    place('<button id="t">x</button><div class="tut"><div class="tut-bubble" id="b"></div></div>');
    const el = document.getElementById('t')!;
    box(el, { left: 10, top: 10, width: 20, height: 20 });
    hitTest(() => document.getElementById('b'));
    expect(usableRect(el)).not.toBeNull();
  });
});

describe('locateUsableTarget（複数一致は見えるものの外接矩形）', () => {
  it('自動保存と保存ボタンの2つを包む', () => {
    place('<label data-tutorial="save" id="a"></label><button data-tutorial="save" id="b"></button>');
    const a = document.getElementById('a')!, b = document.getElementById('b')!;
    box(a, { left: 100, top: 10, width: 60, height: 30 });
    box(b, { left: 170, top: 8, width: 50, height: 34 });
    hitTest((x) => (x < 165 ? a : b));
    expect(locateUsableTarget('[data-tutorial="save"]')).toEqual({ left: 100, top: 8, right: 220, bottom: 42, width: 120, height: 34 });
  });
  it('片方が見えなければ見える方だけ', () => {
    place('<label data-tutorial="save" id="a" hidden></label><button data-tutorial="save" id="b"></button>');
    const b = document.getElementById('b')!;
    box(document.getElementById('a')!, { left: 100, top: 10, width: 60, height: 30 });
    box(b, { left: 170, top: 8, width: 50, height: 34 });
    hitTest(() => b);
    expect(locateUsableTarget('[data-tutorial="save"]')).toEqual({ left: 170, top: 8, right: 220, bottom: 42, width: 50, height: 34 });
  });
  it('一致なし・全部見えないなら null', () => {
    place('<button data-tutorial="x" hidden></button>');
    expect(locateUsableTarget('[data-tutorial="none"]')).toBeNull();
    expect(locateUsableTarget('[data-tutorial="x"]')).toBeNull();
  });
});

describe('readDialogState（ダイアログの表示）', () => {
  it('何も無ければどちらも false', () => {
    expect(readDialogState()).toEqual({ dialogOpen: false, createDialogOpen: false });
  });
  it.each([
    ['ヘルプ', '<div class="help-overlay"></div>'],
    ['設定（aria-modal）', '<div class="native-dialog" role="dialog" aria-modal="true"></div>'],
    ['書き出しパネル', '<section class="native-export-panel"></section>'],
    ['AIの作業・通知', '<div class="preference-overlay"></div>'],
  ])('%s の表示中は dialogOpen', (_label, html) => {
    place(html);
    expect(readDialogState().dialogOpen).toBe(true);
  });
  it('作成ダイアログは dialogOpen と createDialogOpen の両方', () => {
    place('<div class="export-overlay"><div class="export-dialog home-create-dialog"></div></div>');
    expect(readDialogState()).toEqual({ dialogOpen: true, createDialogOpen: true });
  });
  it('チュートリアルの吹き出し（role=dialog だが aria-modal なし）は数えない', () => {
    place('<div class="tut"><div class="tut-bubble" role="dialog" aria-label="チュートリアル"></div></div>');
    expect(readDialogState()).toEqual({ dialogOpen: false, createDialogOpen: false });
  });
});

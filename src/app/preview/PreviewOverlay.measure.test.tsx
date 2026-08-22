/**
 * @vitest-environment jsdom
 *
 * 選択枠の実測（measured）とフォールバック（fallback）の結線テスト。
 * 設計書: docs/specs/2026-08-19-measured-overlay-box-design.md §1 / §4 / §5
 *
 * jsdom の getBoundingClientRect は既定で全ゼロ＝実測ゼロなので、**フォールバック経路**は
 * そのまま検証できる（設計 §4）。**実測経路**は getBoundingClientRect を差し替えて
 * 「目印つき DOM が同一 stage 内にある」状況を作って検証する（本物の Remotion 描画の
 * 一致は e2e「選択枠実測」が担う）。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorImage, EditorTelop } from '../../core/types';
import { initialEditState, type EditState } from '../edit/editState';
import { PreviewOverlay } from './PreviewOverlay';
import { fitContentRect, telopBoxRect } from './overlayGeometry';

const COMP_W = 1080;
const COMP_H = 1920;
const STAGE_W = 270;
const STAGE_H = 480;

class FakeResizeObserver {
  constructor(private readonly cb: (entries: { contentRect: DOMRectReadOnly }[]) => void) {}
  observe(): void {
    this.cb([{ contentRect: { width: STAGE_W, height: STAGE_H } as DOMRectReadOnly }]);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

/** 実測させたい矩形（要素→client 矩形）。空なら全ゼロ＝実測ゼロ。 */
const rects = new Map<Element, { left: number; top: number; width: number; height: number }>();
const ZERO = { left: 0, top: 0, width: 0, height: 0 };

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const r = rects.get(this) ?? ZERO;
    return {
      ...r,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => r,
    } as DOMRect;
  };
});

interface HarnessProps {
  telops?: EditorTelop[];
  images?: EditorImage[];
  selection?: EditState['selection'];
  /** 目印つきのダミー合成 DOM を stage 内に描くか（実測経路の再現）。 */
  withComposition?: boolean;
  /** 合成 DOM は出すが telop 1 のラッパーだけ描かない（＝そのフレームで非表示の再現）。 */
  hideTelop1?: boolean;
  onCommit?: (s: EditState) => void;
}

/** フレーム 0 で可視のテロップ 2 件。 */
function visibleTelops(): EditorTelop[] {
  return [
    { id: 1, originalStart: 0, originalEnd: 400, text: 'てろっぷA', template: 1 },
    { id: 2, originalStart: 0, originalEnd: 400, text: 'てろっぷB', template: 1 },
  ];
}

/**
 * `.pv-stage`（PreviewOverlay の親）＋ダミー合成 DOM ＋ PreviewOverlay を描く。
 * 実 Preview.tsx と同じ入れ子（stage > [Player の描画 / pv-overlay]）を再現する。
 */
function Harness({ telops, images, selection, withComposition, hideTelop1, onCommit }: HarnessProps) {
  const [state, setState] = useState<EditState>(() => ({
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    telops: telops ?? visibleTelops(),
    images: images ?? [],
    selection: selection ?? { kind: 'telop', id: 1 },
  }));
  const playerRef = useRef<PlayerRef | null>(null);
  return (
    <div className="pv-stage">
      {withComposition === true && (
        <div data-sme-root="" data-testid="sme-root">
          {/* 合併規則 v2 では「文字を持つ leaf」が描画物。実際のテロップ部品と同じく
              テキストを持たせる（空の span は描かれていないので測定対象にならない）。 */}
          {hideTelop1 !== true && (
            <div data-sme-kind="telop" data-sme-id="1">
              <span data-testid="telop1-text">てろっぷA</span>
            </div>
          )}
          <div data-sme-kind="telop" data-sme-id="2">
            <span data-testid="telop2-text">てろっぷB</span>
          </div>
          <div data-sme-kind="image" data-sme-id="7">
            <img data-testid="image7" alt="" />
          </div>
        </div>
      )}
      <PreviewOverlay
        compWidth={COMP_W}
        compHeight={COMP_H}
        state={state}
        onLive={setState}
        onEdit={(next) => {
          onCommit?.(next);
          setState(next);
        }}
        playerRef={playerRef}
      />
    </div>
  );
}

/** stage・overlay・合成 DOM の矩形を登録する（実測経路の下ごしらえ）。 */
function primeRects(container: HTMLElement, entries: [string, number[]][]): void {
  const overlay = container.querySelector('.pv-overlay');
  const root = container.querySelector('[data-sme-root]');
  if (overlay) rects.set(overlay, { left: 0, top: 0, width: STAGE_W, height: STAGE_H });
  if (root) rects.set(root, { left: 0, top: 0, width: STAGE_W, height: STAGE_H });
  for (const [testid, [left, top, width, height]] of entries) {
    const el = container.querySelector(`[data-testid="${testid}"]`);
    if (el) rects.set(el, { left: left!, top: top!, width: width!, height: height! });
  }
}

/** 予約済みの再測（rAF）を流し切る。 */
async function flushScheduled(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

afterEach(() => {
  cleanup();
  rects.clear();
});

describe('実測ゼロ（jsdom 既定）＝フォールバック経路', () => {
  it('枠は従来式（telopBoxRect）で出て data-sme-box-source="fallback" が付く', () => {
    const { container } = render(<Harness />);
    const boxEl = container.querySelector('.pv-telop-box') as HTMLElement | null;
    if (!boxEl) throw new Error('.pv-telop-box が無い');
    expect(boxEl.getAttribute('data-sme-box-source')).toBe('fallback');

    const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
    const expected = telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H);
    expect(boxEl.style.left).toBe(`${expected.x}px`);
    expect(boxEl.style.top).toBe(`${expected.y}px`);
    expect(boxEl.style.width).toBe(`${expected.w}px`);
  });

  it('フォールバック中でも本体ドラッグは従来どおり確定される（枠が消えて掴めなくならない）', () => {
    const commits: EditState[] = [];
    const { container } = render(<Harness onCommit={(s) => commits.push(s)} />);
    const grab = container.querySelector('.pv-telop-grab');
    if (!grab) throw new Error('.pv-telop-grab が無い');
    fireEvent.pointerDown(grab, { clientX: 100, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 140, clientY: 200 });
    expect(commits).toHaveLength(1);
    expect(commits[0]!.telops.find((t) => t.id === 1)?.position).toEqual({ x: 1 / 3, y: 0 });
  });
});

describe('実測経路（目印つき DOM が同一 stage にある）', () => {
  it('テロップ枠は実測矩形と一致し data-sme-box-source="measured" が付く', () => {
    const { container, rerender } = render(<Harness withComposition />);
    // 1 回目の描画で矩形を登録し、再描画で layout effect の実測を通す。
    primeRects(container, [['telop1-text', [35, 300, 200, 60]]]);
    rerender(<Harness withComposition />);

    const boxEl = container.querySelector('.pv-telop-box') as HTMLElement | null;
    if (!boxEl) throw new Error('.pv-telop-box が無い');
    expect(boxEl.getAttribute('data-sme-box-source')).toBe('measured');
    expect(boxEl.style.left).toBe('35px');
    expect(boxEl.style.top).toBe('300px');
    expect(boxEl.style.width).toBe('200px');
    expect(boxEl.style.height).toBe('60px');

    // 従来の固定割合近似とは異なる（＝実測が効いている証拠）。
    const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
    const approx = telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H);
    expect(boxEl.style.top).not.toBe(`${approx.y}px`);
  });

  it('挿入画像でも実測枠が効く（全画面×scale の近似ではない）', () => {
    const images: EditorImage[] = [
      { id: 7, originalStart: 0, originalEnd: 400, file: 'a.png', type: 'photo', scale: 1 },
    ];
    const props: HarnessProps = { withComposition: true, images, selection: { kind: 'image', id: 7 } };
    const { container, rerender } = render(<Harness {...props} />);
    primeRects(container, [['image7', [40, 60, 120, 90]]]);
    rerender(<Harness {...props} />);

    const boxEl = container.querySelector('.pv-telop-box') as HTMLElement | null;
    if (!boxEl) throw new Error('.pv-telop-box が無い');
    expect(boxEl.getAttribute('data-sme-box-source')).toBe('measured');
    expect(boxEl.style.left).toBe('40px');
    expect(boxEl.style.width).toBe('120px');
    // 全画面近似（content 全面）ではない。
    expect(boxEl.style.width).not.toBe(`${STAGE_W}px`);
  });

  it('未ロードの画像でも load 契機で再測される（リスナ配線は測定の成否と切り離す）', async () => {
    // 初回は naturalSize 0（＝実測ゼロ）。ここで load リスナが張られないと、
    // 画像が読み終わっても再測が走らず永久にフォールバックのままになる（レビュー P2-1）。
    const images: EditorImage[] = [
      { id: 7, originalStart: 0, originalEnd: 400, file: 'a.png', type: 'photo', scale: 1 },
    ];
    const props: HarnessProps = { withComposition: true, images, selection: { kind: 'image', id: 7 } };
    const { container, rerender } = render(<Harness {...props} />);
    primeRects(container, []); // 画像の矩形は未登録＝寸法ゼロ
    rerender(<Harness {...props} />);
    // マウント直後に積まれた再測（stage の ResizeObserver 由来）を先に流し切る。
    // これを残したまま load を撃つと、load リスナが無くても偶然 measured になり
    // 「張られていないこと」を検出できない（偽グリーン）。
    await flushScheduled();
    expect(
      (container.querySelector('.pv-telop-box') as HTMLElement).getAttribute('data-sme-box-source'),
    ).toBe('fallback');

    // 読み込み完了で実寸が入り、load が発火する。
    const img = container.querySelector('[data-testid="image7"]') as HTMLElement;
    rects.set(img, { left: 40, top: 60, width: 120, height: 90 });
    fireEvent.load(img);

    await waitFor(() => {
      const boxEl = container.querySelector('.pv-telop-box') as HTMLElement;
      expect(boxEl.getAttribute('data-sme-box-source')).toBe('measured');
      expect(boxEl.style.width).toBe('120px');
    });
  });



  it('対象が現在フレームで描かれなくなったら実測値を捨てて従来式へ戻る', () => {
    const { container, rerender } = render(<Harness withComposition />);
    primeRects(container, [['telop1-text', [35, 300, 200, 60]]]);
    rerender(<Harness withComposition />);
    expect(
      (container.querySelector('.pv-telop-box') as HTMLElement).getAttribute('data-sme-box-source'),
    ).toBe('measured');

    // 測定ルートは残ったままテロップのラッパーだけ消える＝そのフレームでは描かれていない
    //（Remotion の TelopLayer が null を返す状態）。古い枠を残さない。
    rerender(<Harness withComposition hideTelop1 />);
    const boxEl = container.querySelector('.pv-telop-box') as HTMLElement;
    expect(boxEl.getAttribute('data-sme-box-source')).toBe('fallback');
    const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
    const approx = telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H);
    expect(boxEl.style.top).toBe(`${approx.y}px`);
  });

  it('実測枠が薄くコントロール帯に食われても掴み面が最低限確保される', () => {
    // 実測枠は文字の高さそのもの（＝薄い）。テロップは画面下部にあるため、下端が
    // プレイヤーのコントロール帯（下 48px）にかかると掴み面が数 px まで痩せる。
    // その場合は枠の**上**へ帯を伸ばす（コントロール帯は侵さない）。
    const { container, rerender } = render(<Harness withComposition />);
    primeRects(container, [['telop1-text', [35, 420, 200, 16]]]);
    rerender(<Harness withComposition />);

    const boxEl = container.querySelector('.pv-telop-box') as HTMLElement;
    expect(boxEl.getAttribute('data-sme-box-source')).toBe('measured');
    const grab = container.querySelector('.pv-telop-grab') as HTMLElement | null;
    if (!grab) throw new Error('.pv-telop-grab が無い（掴めない）');
    // 掴み面の下端は stage 下端 -48px を超えない。
    const top = parseFloat(grab.style.top);
    const height = parseFloat(grab.style.height);
    expect(420 + top + height).toBeLessThanOrEqual(STAGE_H - 48);
    // 最低 24px は確保される（枠の上へ伸びる＝top は負になる）。
    expect(height).toBeGreaterThanOrEqual(24);
    expect(top).toBeLessThan(0);
  });

  it('未選択テロップのヒット領域は pointer 時のオンデマンド測定で実測矩形になる', () => {
    const { container, rerender } = render(<Harness withComposition />);
    primeRects(container, [
      ['telop1-text', [35, 300, 200, 60]],
      ['telop2-text', [50, 380, 160, 40]],
    ]);
    rerender(<Harness withComposition />);

    const stage = container.querySelector('.pv-stage');
    if (!stage) throw new Error('.pv-stage が無い');
    fireEvent.pointerMove(stage, { clientX: 60, clientY: 390 });

    // 選択中（id:1）を除いた id:2 のヒット領域が実測矩形へ移る。
    const hit = container.querySelector('.pv-hit') as HTMLElement | null;
    if (!hit) throw new Error('.pv-hit が無い');
    expect(hit.style.left).toBe('50px');
    expect(hit.style.top).toBe('380px');
    expect(hit.style.width).toBe('160px');
    expect(hit.style.height).toBe('40px');
  });

  it('測定できないテロップのヒット領域は従来式のままになる（補完）', () => {
    const { container, rerender } = render(<Harness withComposition />);
    // telop2 は矩形未登録＝測定不能。
    primeRects(container, [['telop1-text', [35, 300, 200, 60]]]);
    rerender(<Harness withComposition />);

    const stage = container.querySelector('.pv-stage');
    fireEvent.pointerMove(stage as Element, { clientX: 60, clientY: 390 });

    const hit = container.querySelector('.pv-hit') as HTMLElement | null;
    if (!hit) throw new Error('.pv-hit が無い');
    const content = fitContentRect(STAGE_W, STAGE_H, COMP_W, COMP_H);
    const approx = telopBoxRect(content, { x: 0, y: 0 }, 1, COMP_W, COMP_H);
    expect(hit.style.left).toBe(`${approx.x}px`);
    expect(hit.style.top).toBe(`${approx.y}px`);
  });
});

describe('目印（data-sme-*）の綴り契約', () => {
  it('EditorComposition が測定ルートと 3 種のラッパー目印を出す', () => {
    // 測定側（measureBox の query）と描画側の綴りが食い違うと、実測は黙って
    // フォールバックへ落ちる（枠は出るので気づけない）。綴りだけをここで固定する。
    const src = readFileSync(
      resolve(import.meta.dirname, '../../preview/EditorComposition.tsx'),
      'utf8',
    );
    expect(src).toContain('data-sme-root');
    expect(src).toContain('data-sme-kind="telop"');
    expect(src).toContain('data-sme-kind="image"');
    expect(src).toContain('data-sme-kind="videoInsert"');
    expect(src).toContain('data-sme-id');
  });
});

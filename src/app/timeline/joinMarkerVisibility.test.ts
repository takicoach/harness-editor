import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * シーン転換のひし形（`.tl-join-mark`）が **切り落とされずに見えている** ことの回帰ガード。
 *
 * 背景（2026-08-26 実機フィードバック「ひし形マークが出ない」）。原因は 2 段あった:
 *
 * 1. **横方向の切れ**: マークは `.tl-scroll` 基準の配置だが、その親 `.tl-body` は
 *    `overflow-x:auto; overflow-y:auto`。旧値 `top:-6px` は `.tl-scroll` の外側で、
 *    実測でマーク y=582.3〜600.7 に対し `.tl-body` の上端が y=591 ＝ **47% が不可視**。
 *    残った下半分も頭マーク（frame 0）では再生ヘッドの三角と重なり、実質「存在しない」ように見えた。
 * 2. **縦スクロールで消える**: マーカー層が `position:absolute` のままだと、sticky な
 *    `.tl-ruler` に追従せず一緒にスクロールアウトする。`.tl-scroll` の中身は既定の
 *    `--timeline-h:240px`（`.tl-head` 30px を引いた表示域 ≒209px）を超えるので縦スクロールは
 *    日常的に起き、**scrollTop がひし形の高さぶん進んだだけで完全に消える**＝1 の修正だけでは
 *    実機フィードバックと同じ絵に戻る。マーカー層は sticky でなければならない。
 *
 * ここでは styles.css を読んで幾何を計算する（**テスト側に数値を書き写さない**）。
 * 45 度回転した一辺 s の正方形の外接高さは s * √2 なので、可視の上端は
 * `top - (s * √2 - s) / 2`。これが 0 以上であれば `.tl-body` に切られない。
 */

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');

/** セレクタのブロック本文を返す。 */
function block(selector: string): string {
  const m = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(m, `${selector} の規則が styles.css に見つかりません`).not.toBeNull();
  return m![1]!;
}

/**
 * セレクタのブロックから 1 プロパティを数値で取り出す（単位 px は任意）。
 * **同じブロックに複数回書かれていれば最後の一致を採る**（CSS は後勝ちなので、
 * 先頭の一致を返すと実際に効いていない値を検査してしまう）。
 */
function num(selector: string, prop: string): number {
  const body = block(selector);
  // 直前がプロパティ名の一部でないこと（`top` が `padding-top` に当たらないこと）だけを見る。
  // ブロック内にはコメントが挟まるので `;` 直後には限定しない。
  const re = new RegExp(`(?:^|[^-\\w])${prop}\\s*:\\s*(-?[\\d.]+)(?:px)?\\s*(?:;|$)`, 'g');
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) last = m;
  expect(last, `${selector} に ${prop} がありません`).not.toBeNull();
  return Number(last![1]);
}

/** セレクタのブロックから 1 プロパティをキーワード値で取り出す（後勝ち）。 */
function keyword(selector: string, prop: string): string {
  const body = block(selector);
  const re = new RegExp(`(?:^|[^-\\w])${prop}\\s*:\\s*([a-z-]+)\\s*(?:;|$)`, 'g');
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) last = m;
  expect(last, `${selector} に ${prop} がありません`).not.toBeNull();
  return last![1]!;
}

const px = num;
/** ルーラーの高さも styles.css から読む（テストに 30 を書き写さない）。 */
const RULER_HEIGHT_PX = px('.tl-ruler', 'height');
const RULER_Z = px('.tl-ruler', 'z-index');
const PLAYHEAD_Z = px('.tl-playhead', 'z-index');

/** 45 度回転した一辺 size の正方形が占める、top 基準の [上端, 下端]。 */
function rotatedSpan(top: number, size: number): [number, number] {
  const overhang = (size * Math.SQRT2 - size) / 2;
  return [top - overhang, top + size + overhang];
}

describe('.tl-join-markers（マーカー層）', () => {
  it('sticky で、縦スクロールしてもルーラーと一緒に貼り付く', () => {
    // absolute のままだと .tl-body の縦スクロールで一緒に流れて消える（実機フィードバックの再現条件）。
    expect(
      keyword('.tl-join-markers', 'position'),
      'マーカー層が sticky でないと縦スクロールでひし形が消える',
    ).toBe('sticky');
    expect(px('.tl-join-markers', 'top'), 'sticky の貼り付き位置はスクロール域の上端').toBe(0);
  });

  it('レイアウトを押し下げない（height:0 の被せ層）', () => {
    expect(px('.tl-join-markers', 'height')).toBe(0);
  });

  it('ルーラーと再生ヘッドの前面に出る', () => {
    const z = px('.tl-join-markers', 'z-index');
    expect(z, `ルーラー(z-index:${RULER_Z})より前面`).toBeGreaterThan(RULER_Z);
    expect(z, `再生ヘッド(z-index:${PLAYHEAD_Z})より前面`).toBeGreaterThan(PLAYHEAD_Z);
  });
});

describe('.tl-join-mark の可視性', () => {
  it('通常時のひし形が .tl-body に切り落とされず、ルーラーの内側に収まる', () => {
    const [top, bottom] = rotatedSpan(px('.tl-join-mark', 'top'), px('.tl-join-mark', 'width'));
    expect(top, '上端がマイナス＝.tl-body の overflow で切り落とされる').toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(RULER_HEIGHT_PX);
  });

  it('選択中（拡大表示）のひし形も切り落とされない', () => {
    const [top, bottom] = rotatedSpan(
      px('.tl-join-mark.selected', 'top'),
      px('.tl-join-mark.selected', 'width'),
    );
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(RULER_HEIGHT_PX);
  });

  /**
   * 時刻ラベルの帯と交差しない（サイクル 4 レビュー Important）。
   *
   * fit 倍率が既定の初期画面になったため、ひし形が時刻ラベルの上に重なると
   * 「4◇◇◇◇◇◇」のようにラベルが読めない（41-open-fit-1440.png / 45-1280x720.png）。
   * 横方向の間引き（clusterJoinMarks）だけでは 1 個残ったひし形がラベルに乗るので、
   * **帯を縦に分ける**のが不変条件。数値はすべて styles.css から読む。
   */
  it('時刻ラベルの帯と縦に交差しない（通常・選択中とも）', () => {
    const labelTop = px('.tl-tick-label', 'top');
    const labelBottom = labelTop + px('.tl-tick-label', 'line-height');
    for (const sel of ['.tl-join-mark', '.tl-join-mark.selected']) {
      const [top] = rotatedSpan(px(sel, 'top'), px(sel, 'width'));
      expect(top, `${sel} の上端がラベル帯（〜${labelBottom}px）に食い込んでいる`).toBeGreaterThanOrEqual(
        labelBottom,
      );
    }
  });

  it('選択で中心がずれない（拡大しても同じ位置で大きくなる）', () => {
    const normalCenter = px('.tl-join-mark', 'top') + px('.tl-join-mark', 'width') / 2;
    const selectedCenter =
      px('.tl-join-mark.selected', 'top') + px('.tl-join-mark.selected', 'width') / 2;
    expect(selectedCenter).toBeCloseTo(normalCenter, 5);
  });
});

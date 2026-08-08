import type { EditorTelop, WordChip } from './types';

/**
 * テロップ本文を atFrame（原本フレーム）で左右へ分ける。
 * - 単語チップがあり、atFrame の前後にチップが分かれる場合はチップ境界で分割する。
 *   本文がチップ連結と一致すればそのまま、編集済みなら左チップ合計文字数で近似する。
 * - チップが使えない場合は時間比で文字位置を決める（2 文字以上なら両側 1 文字以上を保証）。
 */
export function splitTelopText(
  text: string,
  originalStart: number,
  originalEnd: number,
  atFrame: number,
  chips: WordChip[],
): [string, string] {
  if (text.length <= 1) return [text, ''];

  // チップ中点が atFrame より前のものを左側とみなす（chips は時刻順前提）。
  const leftCount = chips.filter((c) => (c.originalStart + c.originalEnd) / 2 < atFrame).length;
  if (leftCount > 0 && leftCount < chips.length) {
    const leftJoined = chips.slice(0, leftCount).map((c) => c.text).join('');
    const allJoined = chips.map((c) => c.text).join('');
    // 改行は表示用（2行テロップ）でチップには存在しないため、照合と文字数カウントは
    // 改行を除いた本文で行う。除かないと \n の分だけ分割位置がズレる。
    if (allJoined === text.replace(/\n/g, '')) {
      // 元テキスト上で「改行以外の文字を leftJoined.length 個」消費した位置を境界にする。
      let plain = 0;
      let k = 0;
      while (k < text.length && plain < leftJoined.length) {
        if (text[k] !== '\n') plain++;
        k++;
      }
      const left = text.slice(0, k).replace(/\n+$/, '');
      const right = text.slice(k).replace(/^\n+/, '');
      if (left !== '' && right !== '') return [left, right];
    }
    const k = Math.min(text.length - 1, Math.max(1, leftJoined.length));
    return [text.slice(0, k), text.slice(k)];
  }

  // 時間比フォールバック。区間が不正でも 0..1 へクランプする。
  const span = originalEnd - originalStart;
  const ratio = span > 0 ? (atFrame - originalStart) / span : 0.5;
  const idx = Math.min(
    text.length - 1,
    Math.max(1, Math.round(text.length * Math.min(1, Math.max(0, ratio)))),
  );
  return [text.slice(0, idx), text.slice(idx)];
}

/**
 * テキストに改行があるとき、「改行位置で分割する」計画を返す（無ければ null）。
 *
 * 分割ボタンの UX: ユーザーは textarea に改行を入れて「ここで割りたい」を表現する。
 * 改行が無い場合は従来どおり時間中央分割（呼び出し側の責務）。
 * - atFrame: 改行直前までの文字数をチップ列に照合し、境界チップ間の中点フレーム。
 *   照合できない（誤字修正等でチップと本文が不一致）場合は文字比率で近似。
 * - leftText/rightText: 改行で分けた本文（境界の改行自体は取り除く）。
 */
export function newlineSplitPlan(
  text: string,
  chips: WordChip[],
  originalStart: number,
  originalEnd: number,
): { atFrame: number; leftText: string; rightText: string } | null {
  const idx = text.indexOf('\n');
  if (idx <= 0) return null;
  const leftText = text.slice(0, idx).replace(/\n+$/, '');
  const rightText = text.slice(idx + 1).replace(/^\n+/, '');
  if (leftText === '' || rightText === '') return null;

  const clampInside = (f: number): number =>
    Math.min(originalEnd - 1, Math.max(originalStart + 1, Math.round(f)));

  // チップ照合: 改行前の文字数がチップ境界とちょうど一致すれば、その境界の中点フレーム。
  const leftPlainLen = leftText.replace(/\n/g, '').length;
  const allJoined = chips.map((c) => c.text).join('');
  if (allJoined === text.replace(/\n/g, '')) {
    let acc = 0;
    for (let i = 0; i < chips.length - 1; i++) {
      acc += chips[i]!.text.length;
      if (acc === leftPlainLen) {
        const boundary = (chips[i]!.originalEnd + chips[i + 1]!.originalStart) / 2;
        return { atFrame: clampInside(boundary), leftText, rightText };
      }
      if (acc > leftPlainLen) break; // 改行がチップの途中 → 比率フォールバックへ
    }
  }

  // 文字比率フォールバック（改行を除いた文字数ベース）。
  const totalPlain = text.replace(/\n/g, '').length;
  const ratio = totalPlain > 0 ? leftPlainLen / totalPlain : 0.5;
  return {
    atFrame: clampInside(originalStart + (originalEnd - originalStart) * ratio),
    leftText,
    rightText,
  };
}

/**
 * セグメントを atFrame（原本フレーム）で 2 つに分割する。
 * テキストの分け方（leftText / rightText）は呼び出し側が決める。
 * 後半セグメントには newId を割り当てる。
 */
export function splitSegment(
  telop: EditorTelop,
  atFrame: number,
  leftText: string,
  rightText: string,
  newId: number,
): [EditorTelop, EditorTelop] {
  if (atFrame <= telop.originalStart || atFrame >= telop.originalEnd) {
    throw new Error(`分割位置 ${atFrame} がセグメント区間外です`);
  }
  const left: EditorTelop = { ...telop, originalEnd: atFrame, text: leftText };
  const right: EditorTelop = {
    ...telop,
    id: newId,
    originalStart: atFrame,
    text: rightText,
  };
  return [left, right];
}

/**
 * 原本フレーム frame を区間 [originalStart, originalEnd) に含む最初のテロップを返す。
 * end は排他（既存のカット区間規約と一致）。該当が無ければ undefined。
 * テロップが重なっている場合は配列順で最初にマッチしたものを返す。
 * 「再生ヘッド位置でテロップを分割」の対象判定に使う。
 */
export function telopAtFrame(telops: EditorTelop[], frame: number): EditorTelop | undefined {
  return telops.find((t) => t.originalStart <= frame && frame < t.originalEnd);
}

/**
 * 指定フレームで表示中（originalStart<=frame<originalEnd）の全テロップを入力順で返す。
 */
export function telopsAtFrame(telops: EditorTelop[], frame: number): EditorTelop[] {
  return telops.filter((t) => t.originalStart <= frame && frame < t.originalEnd);
}

/**
 * 隣接する 2 セグメントを 1 つに結合する。
 * 区間は first.originalStart 〜 second.originalEnd、属性は first を引き継ぐ。
 * テキストは joiner で連結（日本語想定の既定は空文字）。
 */
export function mergeSegments(
  first: EditorTelop,
  second: EditorTelop,
  newId: number,
  joiner = '',
): EditorTelop {
  return {
    ...first,
    id: newId,
    originalStart: Math.min(first.originalStart, second.originalStart),
    originalEnd: Math.max(first.originalEnd, second.originalEnd),
    text: first.text + joiner + second.text,
  };
}

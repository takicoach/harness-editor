/**
 * カラー補正（F-2）が**この案件の書き出しに反映されるか**の目印と文言。
 *
 * 色を実際に絵にするのは案件へコピーされた `src/MainLayout/`（＋ `MainVideo.tsx` の配線）。
 * 未導入・旧版のままの案件では、補正を掛けてもプレビューだけ変わって書き出しに出ない
 * ——**黙って食い違う**のが最悪なので、目印の有無で判定して UI で伝える。
 *
 * サーバ（部品ファイルの走査）とクライアント（注意書きの表示）の両方から使うため、
 * node 依存を持たない共有モジュールに置く（shared/motionKeys.ts と同じ流儀）。
 */

/** 対応済み部品に必ず含まれる目印。 */
export const COLOR_GRADE_MARKER = 'COLOR_GRADE_V1';

/** 未対応時に UI へ出す文言。 */
export const COLOR_GRADE_UNSUPPORTED =
  'この案件はカラー補正が書き出しに反映されない状態です（プレビューだけ変わります）。' +
  '下の「レイアウトを書き出しに導入」を実行すると反映されるようになります。';

/**
 * `<MainLayout>` … `</MainLayout>` の範囲（開始 index・終了 index）を列挙する。
 * 閉じタグが見つからない断片は **末尾まで**を範囲とみなす（fail-closed）。
 * MainLayout は入れ子にしない前提（メイン動画レイヤは 1 つ）。
 */
export function mainLayoutRanges(source: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const openRe = /<MainLayout\b/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(source)) !== null) {
    const close = source.indexOf('</MainLayout>', m.index);
    ranges.push({ start: m.index, end: close === -1 ? source.length : close + '</MainLayout>'.length });
  }
  return ranges;
}

/** その位置が `<MainLayout>` の内側か（＝メイン動画レイヤの変形と補正を二重に浴びる位置か）。 */
export function isInsideMainLayout(source: string, index: number): boolean {
  return mainLayoutRanges(source).some((r) => index > r.start && index < r.end);
}

/**
 * サブ動画レイヤ（`<VideoInsertSequence />`）が **補正レイヤで 1 回だけ**包まれているか。
 * サブ動画未導入なら「食い違う面が無い」ので true。
 *
 * 存在確認だけでは足りない：`<MainLayout>` の内側に置かれた `<ColorGradeLayer scope="insert">` は
 * MainLayout 自身の補正と合わせて **2 回**掛かる（プレビューは兄弟配置＝1 回）。
 * よって「包まれている」に加えて「MainLayout の外側にある」ことまで見る。
 */
export function isVideoInsertColorGradeWired(source: string): boolean {
  const seqRe = /<VideoInsertSequence\b/g;
  const wrapRe = /<ColorGradeLayer[^>]*scope="insert"[^>]*>\s*<VideoInsertSequence\s*\/>\s*<\/ColorGradeLayer>/g;
  const wraps: { start: number; end: number }[] = [];
  let w: RegExpExecArray | null;
  while ((w = wrapRe.exec(source)) !== null) wraps.push({ start: w.index, end: w.index + w[0].length });

  let m: RegExpExecArray | null;
  while ((m = seqRe.exec(source)) !== null) {
    const at = m.index;
    if (isInsideMainLayout(source, at)) return false;
    if (!wraps.some((r) => at > r.start && at < r.end)) return false;
  }
  return true;
}

/**
 * 波形ドラッグでイン点（sourceInFrame）を調整したときの「確定（pointer up）」の履歴整合。
 *
 * ドラッグ中は onLive（= session.setTransient）が現在の履歴エントリを live 値で**上書き**する。
 * そのまま onCommit（= session.apply）で final を積むと、履歴は `[..., 最後のlive, final]` になり、
 * Undo が pre-drag でなく「最後の live プレビュー値」に戻る（Ctrl+Z が効かないように見える）。
 *
 * 対策は PreviewOverlay と同じ: commit 前にまず onLive(startIn) で現在エントリを pre-drag のイン点へ
 * 戻し、その後 onCommit(final) で 1 件だけ積む → 履歴 `[..., preDrag, final]`。Undo が pre-drag に戻る。
 * 値が変わっていなければ復元のみで履歴は積まない。
 */
export function commitInPointDrag(
  startIn: number,
  finalIn: number,
  cb: { onLive: (sourceInFrame: number) => void; onCommit: (sourceInFrame: number) => void },
): void {
  // drag 中の setTransient で潰れた現在エントリを pre-drag の値へ復元する（冪等＝無移動でも無害）。
  cb.onLive(startIn);
  // 実際に動いたときだけ final を履歴へ積む。
  if (finalIn !== startIn) cb.onCommit(finalIn);
}

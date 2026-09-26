/**
 * 前面モーダル判定（タイムライン・App のキー操作で共有する）。
 *
 * 元は Timeline.tsx の中にあり、App 側の Cmd+Z / Cmd+Shift+Z / Cmd+S はガードを
 * 通っていなかった。ヘルプや書き出しダイアログを開いたまま押した Undo が、
 * 見えていないタイムラインの編集を巻き戻してしまう（サイクル 1 レビューの残件）。
 * 判定を 1 か所に置き、両方が同じ定義を使う。
 */

/**
 * 前面に出るモーダルの目印。表示中は JKL・←→ のトランスポート操作や
 * 破壊的キー・Undo/Redo を止め、モーダル側のキー操作に譲る。プレビュー上の常設
 * オーバーレイ（.pv-overlay）はモーダルではないので含めない。
 *
 * チュートリアルの暗幕（.tut）も**含めない**。あれは pointer-events:none の
 * 指さしオーバーレイで、照準のボタンをそのまま押させる設計（TutorialOverlay.tsx）。
 * ここに入れていた間は、save ステップが「⌘S でも OK」と案内しているのに ⌘S・⌘Z が
 * 一切効かず、初回利用者に「⌘S が壊れている」と読ませていた（サイクル 2 レビュー）。
 *
 * 学習パネル（.diff-review-overlay）は他のダイアログの後ろで hidden のまま待つことがある。待機中は
 * 数えない（「AIの作業」の閲覧中に AI の編集を止めない＝待機を unmount で実装していた頃と同じ判定）。
 */
export const MODAL_SELECTOR = '.help-overlay, .export-overlay, .hjc-overlay, .diff-review-overlay:not([hidden]), .preference-overlay, .native-style-overlay';

/**
 * 前面にモーダルが出ているか。
 *
 * タイムラインの window keydown は「画面の一番後ろ」で待ち構えているため、
 * 前面のダイアログを開いたまま押した Delete / B / ←→ が**見えないタイムライン**に
 * 届いてしまう（監査 interaction-1・Critical）。破壊的なキーを扱う effect は
 * 例外なくこの判定を冒頭で通す。
 *
 * 例外は Alt 押下追跡の keydown/keyup 対（吸着の一時解除）だけ。あちらは編集を
 * 起こさず、down だけを止めると Alt が押しっぱなし扱いで固着するため対称に残す。
 */
export function isModalOpen(): boolean {
  return document.querySelector(MODAL_SELECTOR) !== null;
}

/**
 * A history viewer captures keyboard input but does not own the edit state.
 * Keep agent delivery running while it is merely displaying progress. An action
 * or saved-state review opts back into the same guard as every other dialog.
 * Check every overlay so a viewer cannot exempt a second, blocking dialog.
 */
export function isAgentEditBlocked(): boolean {
  return Array.from(document.querySelectorAll(MODAL_SELECTOR)).some((overlay) =>
    !overlay.matches('.preference-overlay[data-editor-activity="viewing"]'));
}

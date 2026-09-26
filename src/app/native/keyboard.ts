/**
 * M-5': Esc の判定を字句 1 つに集める。
 *
 * 日本語入力の変換中に押す Esc は「変換の取り消し」で、アプリの Esc（閉じる・下書きを戻す）ではない。
 * ガードを各所に手で書くと、次に増えた 1 箇所で必ず抜ける（気づきにくい症状で出る: 変換を取り消した
 * だけでダイアログが閉じる・入力中の下書きが巻き戻る）。
 *
 * M-7: ここを通すのは「ダイアログ・ポップオーバー・入力欄」の Esc（`isEscape` / `useDialogEscape` 経由）。
 * ドラッグ中断（例: 操作を Esc で取り消す）の Esc は対象外 — 別の意味（値を戻す）を持ち、IME ガードの
 * 要否も呼び出し側の事情が異なるため、ここへ寄せない。その例外は逐語の許可リストとして
 * `escapeGuard.test.ts` が持ち、そこに無い直書きの Esc は機械で落ちる。
 *
 * React の合成イベントは `isComposing` を持たないので、呼ぶ側は `event.nativeEvent` を渡す。
 */
export const isEscape = (event: {key: string; isComposing: boolean}): boolean => event.key === 'Escape' && !event.isComposing;

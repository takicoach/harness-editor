/**
 * 端末へ貼る文から制御文字を除く。ESC（貼り付けの終端 ESC[201~ を含む）・CR・BS などが残ると、
 * 貼り付けが途中で閉じて Enter が届き、利用者の確認なしに送信されうる（設計書 5「送るのは利用者」）。
 * 改行（LF）とタブは残す。CRLF は LF にそろえる。
 */
export function stripTerminalControls(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '');
}

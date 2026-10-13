/** AI の端末にカーソルを置く合図（ボタンの依頼を入力欄に貼った後に使う）。端末（AiTerminal）がこの合図を受ける。 */
export const AI_TERMINAL_FOCUS_EVENT = 'sme:ai-terminal-focus';
export function focusAiTerminal(): void {
  window.dispatchEvent(new Event(AI_TERMINAL_FOCUS_EVENT));
}

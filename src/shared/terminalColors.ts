/**
 * 埋め込みターミナルの配色の単一の出所。
 * クライアント（xterm の theme）とサーバー（OSC 10/11 問い合わせへの応答）の両方が
 * ここを読む。両者がずれると「xterm は白いのに TUI は黒背景向けの配色で描く」という
 * 食い違いが起きるため、値の重複定義を禁じる。
 *
 * light を純白 #ffffff / 濃グレー #1a1a1a に振り切っている理由は
 * claudeTerminalOptions.ts の terminalTheme のコメントを参照（styles.css の
 * オフホワイトとあえて分離している）。
 * dark の foreground を明示するのは OSC 応答に必要なため（xterm 既定の前景と
 * 同色なので見た目は変わらない）。
 */
export const TERMINAL_COLORS = {
  light: { background: '#ffffff', foreground: '#1a1a1a' },
  dark: { background: '#101418', foreground: '#ffffff' },
} as const;

export type TerminalThemeName = keyof typeof TERMINAL_COLORS;

/** 'light' 以外はすべて dark 扱い（既存 terminalTheme の判定と同じ）。 */
export function terminalColorsFor(theme: string): { background: string; foreground: string } {
  return theme === 'light' ? TERMINAL_COLORS.light : TERMINAL_COLORS.dark;
}

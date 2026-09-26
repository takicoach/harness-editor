/**
 * AiTerminal.tsx から xterm の Terminal 生成オプションを切り出した純関数群。
 * `@xterm/xterm` は type-only import に限定し、CSS（`@xterm/xterm/css/xterm.css`）を
 * 一切 import しない。これにより本モジュールは jsdom はおろか node 環境の vitest
 * （vitest.config.ts: environment 'node'）からも安全に import できる
 * （AiTerminal.tsx 自体は「xterm は jsdom で描画できない」ため e2e 専任 — この
 * モジュールの切り出しはそこにオプション生成ロジックだけの unit テストを追加するため）。
 */
import type { ITheme } from '@xterm/xterm';
import { terminalColorsFor } from '../../shared/terminalColors';

/**
 * 端末のフォント指定。
 *
 * 修正前は `new Terminal({...})` に fontFamily を渡しておらず、xterm の既定値
 * `'monospace'`（総称 CSS ファミリー）に丸投げしていた。generic 'monospace' が実際に
 * どのフォントへ解決されるかは OS・ブラウザの設定に依存し、環境によっては罫線や
 * 記号（`─│▶⚠╭` 等・Claude Code の TUI が多用する）のグリフを持たないフォント
 * （例: Courier New 系）に解決されうる。その場合ブラウザは文字ごとに別フォントへ
 * フォールバックして描画するため、英数字と罫線・記号で advance width が不揃いになり
 * 「桁がずれる」（実測 12px: 英数字 M/l/O = 7.20px に対し `─│▶⚠╭` が 12.00px まで開く
 * ケースを確認済み）。
 *
 * Windows / Linux の受講生にも配布するため、macOS だけでなく各 OS 標準の等幅フォントを
 * 明示的に列挙する（`ui-monospace` は macOS/iOS で SF Mono を指すが Windows/Linux には
 * 無いキーワードのため、後続に `Cascadia Mono`/`Consolas`（Windows）・
 * `DejaVu Sans Mono`/`Liberation Mono`（Linux）を並べ、最後に総称 `monospace` で
 * 未知環境をフォールバックする）。
 */
export const TERMINAL_FONT_FAMILY =
  'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", monospace';

/**
 * xterm の配色。値の実体は src/shared/terminalColors.ts に置き、
 * サーバー側の OSC 10/11 応答と同じ出所を読む（両者がずれると
 * 「xterm は白いのに TUI は黒背景向けの色で描く」食い違いが起きる）。
 *
 * light を純白 #ffffff / 濃グレー #1a1a1a に振り切っている理由: 端末は
 * 「アプリ画面の一部」ではなく独立した黒い/白い箱として認識されるため、
 * styles.css の light トークン（--bg-1 は #FAF9F5 のオフホワイト）と同化させるより
 * コントラストをはっきり付けた方が「渋滞して見える」問題の解消に沿うと判断した
 * （CSS 変数から読む方式も検討したが、値をあえて分離したいのでハードコードを選択）。
 */
export function terminalTheme(theme: string): ITheme {
  const c = terminalColorsFor(theme);
  return { background: c.background, foreground: c.foreground, cursor: c.foreground };
}

export interface TerminalOptions {
  convertEol: boolean;
  fontSize: number;
  fontFamily: string;
  theme: ITheme;
}

/**
 * lineHeight（既定 1.0）と allowProposedApi / Unicode バージョンは今回のフォント修正では
 * 変更しない。判断根拠:
 * - lineHeight: 今回報告された不具合は「桁（横方向）のずれ」のみで、行間の詰まり・重なりは
 *   報告されていない。既定 1.0 のままで良い。
 * - Unicode バージョン: xterm 本体（`@xterm/xterm`）は追加アドオン無しでも組み込みの
 *   `UnicodeV6` プロバイダで文字幅テーブルを持っており（`node_modules/@xterm/xterm/src/
 *   common/input/UnicodeV6.ts`）、ひらがな・カタカナ・CJK統合漢字（`0x2e80`–`0xa4d0` の範囲）は
 *   既に幅2（全角相当のセル幅）として判定される。`@xterm/addon-unicode11` が拾うのは主に
 *   Unicode 9 以降で追加された絵文字等の新しい結合幅で、Claude の TUI が出す日本語本文
 *   （既存の常用漢字・かな）には影響しない。よって追加導入は不要と判断した。
 * - allowProposedApi: 上記 Unicode 判定は安定 API のみで完結するため不要。
 */

/** `new Terminal(...)` にそのまま渡せる生成オプション一式。 */
export function terminalOptions(theme: string): TerminalOptions {
  return { convertEol: false, fontSize: 12, fontFamily: TERMINAL_FONT_FAMILY, theme: terminalTheme(theme) };
}

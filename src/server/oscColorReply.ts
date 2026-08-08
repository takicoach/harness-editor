/**
 * OSC 10/11（前景色・背景色の問い合わせ）への応答。
 *
 * なぜサーバー側で答えるのか: codex は起動直後に `ESC ] 10 ; ? BEL` /
 * `ESC ] 11 ; ? BEL` を投げ、その返答で描画色を決める（実測: 白背景と答えると
 * 前景が 28,28,28 系の暗色に、黒背景と答えると 230,230,230 系の明色になる）。
 * この問い合わせが飛ぶ時点でブラウザ側の xterm はまだ存在しない
 * （ensure の HTTP 応答 → トークン取得 → WS 接続 → 認証 → React 再描画 →
 * new Terminal() の順で早くても数百 ms かかる）ため、xterm の OSC 応答機能
 * （xterm.js 6.0.0 は実装している）には間に合わない。pty の手前で即答する。
 *
 * セキュリティ: これは writer 接続の認証を経ない唯一の pty 書き込み経路。
 * 応答文字列は TERMINAL_COLORS の 2 値テーブル由来の定数のみで構成し、
 * pty の出力内容やユーザー入力を一切混ぜない。
 */

/** `\x1b]11;?\x1b\\` = 8 文字。跨ぎ検出のため直前チャンクの末尾をこの長さだけ保持する。 */
const MAX_QUERY_LEN = 8;

/** OSC の色問い合わせのみに一致する（`;?` の直後が終端であることを要求するため `;rgb:` は一致しない）。 */
const QUERY_RE = /\x1b\](10|11);\?(?:\x07|\x1b\\)/g;

/** `#rrggbb` を OSC の 16bit 表記 `rgb:RRRR/GGGG/BBBB` へ広げる。 */
export function toOscRgb(hex: string): string {
  const h = hex.replace('#', '');
  const pair = (i: number): string => {
    const c = h.slice(i * 2, i * 2 + 2);
    return c + c;
  };
  return `rgb:${pair(0)}/${pair(1)}/${pair(2)}`;
}

/** OSC 色応答（ST 終端）を組む。 */
export function oscColorReply(code: '10' | '11', hex: string): string {
  return `\x1b]${code};${toOscRgb(hex)}\x1b\\`;
}

/**
 * pty 出力のチャンクを受け取り、答えるべき応答文字列の配列を返す。
 * 問い合わせがチャンク境界で分断されても取りこぼさず、かつ二重に応答しない。
 */
export function createOscColorResponder(
  getColors: () => { background: string; foreground: string },
): (chunk: string) => string[] {
  let carry = '';
  return function onChunk(chunk: string): string[] {
    const buf = carry + chunk;
    const replies: string[] = [];
    let consumedTo = 0;
    QUERY_RE.lastIndex = 0;
    for (const m of buf.matchAll(QUERY_RE)) {
      const code = m[1] === '10' ? '10' : '11';
      const colors = getColors();
      replies.push(oscColorReply(code, code === '10' ? colors.foreground : colors.background));
      consumedTo = (m.index ?? 0) + m[0].length;
    }
    // 応答済み位置より後ろ、かつ末尾 MAX_QUERY_LEN 文字だけを次回へ持ち越す。
    // 応答済みの領域は捨てるので二重応答は起きない。
    carry = buf.slice(Math.max(consumedTo, buf.length - MAX_QUERY_LEN));
    return replies;
  };
}

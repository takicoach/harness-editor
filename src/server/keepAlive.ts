/**
 * dev サーバ（＝製品のローカルサーバ）の keep-alive タイムアウト設定。
 *
 * Node の既定 `keepAliveTimeout` は 5 秒。ブラウザや HTTP クライアントは接続を使い回すため、
 * サーバが「もう切る」と決めた瞬間にクライアントが同じソケットへ次のリクエストを書くと、
 * クライアントからは `ECONNRESET` に見える（切断を知らずに書いているので防げない）。
 *
 * 実測（2026-09-06・H-1）:
 * - 生ソケットで `GET /api/config` → 5.5 秒アイドル → サーバ側から close される（窓の実在）。
 * - フルスイート e2e で `GET /api/config` が `read ECONNRESET` で失敗（5 回に 1 回）。
 *
 * GET はブラウザが自動で張り直して再送するので気づきにくいが、**POST は再送されない**。
 * つまりこの窓に当たった保存（POST /api/save）は「ネットワークエラーで保存失敗」として
 * ユーザーに出る。切るのは常にクライアント側であるべきなので、サーバの上限を延ばす。
 *
 * `headersTimeout` は `keepAliveTimeout` より必ず長くする（短いと、keep-alive で待っている
 * 接続をヘッダ待ちタイムアウトが先に切ってしまい、同じ競合が残る）。
 */

/** アイドル接続を維持する時間（ms）。一般的なクライアントの idle 上限より長くとる。 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/** ヘッダ受信の上限（ms）。keepAliveTimeout より長いこと。 */
export const HEADERS_TIMEOUT_MS = 70_000;

/** タイムアウトを設定できる最小の面（http.Server の部分型）。テスト容易性のため分離。 */
export interface KeepAliveConfigurable {
  keepAliveTimeout: number;
  headersTimeout: number;
}

/**
 * httpServer へ keep-alive タイムアウトを適用する。
 * httpServer が無い（Vite のミドルウェアモード）場合と、この設定を持たないサーバ実装
 * （HTTP/2 サーバ等・keep-alive の概念が異なる）では何もしない。
 */
export function applyKeepAliveTimeouts(server: object | null | undefined): void {
  if (!server) return;
  // Vite の httpServer 型は HTTP/2 サーバとの union で、keep-alive を持つとは限らない。
  const target = server as Partial<KeepAliveConfigurable>;
  if (typeof target.keepAliveTimeout !== 'number') return;
  target.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  target.headersTimeout = HEADERS_TIMEOUT_MS;
}

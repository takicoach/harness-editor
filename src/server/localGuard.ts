/**
 * ローカル専用サーバの防御。
 * このサーバは認証を持たないローカル前提のツールなので、DNS リバインディングや
 * 悪意ある Web ページからの CSRF で /api・/mcp を叩かれないよう、
 * Host / Origin / Sec-Fetch-Site ヘッダを検証したリクエストだけを許可する。
 *
 * 重要: Origin は no-cors の GET（<img>/<script> 等）では送られないため Origin だけでは
 * cross-site GET を防げない。Sec-Fetch-Site はブラウザが全リクエストに必ず付与し
 * Web コンテンツからは偽装できないので、これで cross-site を確実に弾く。
 */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 重複ヘッダ（配列）を表すマーカー。fail-open を避けるため許可判定では常に不許可扱いにする。 */
const DUPLICATE = Symbol('duplicate-header');

/**
 * ヘッダ値を1つに正規化する。重複ヘッダ（配列）は fail-open を避けるため DUPLICATE を返す
 * （先頭要素だけ見ると ['same-origin','cross-site'] のような細工を通してしまう）。
 */
function headerValue(v: string | string[] | undefined): string | undefined | typeof DUPLICATE {
  if (Array.isArray(v)) return DUPLICATE;
  return v;
}

/** Host ヘッダ（例: "localhost:2109"）がローカルを指すか。無い・不正な場合は拒否。 */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const { hostname } = new URL(`http://${host}`);
    return LOCAL_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Origin ヘッダがローカル起源か。
 * 同一オリジンの GET や curl 等は Origin を送らないため、未指定は許可する。
 * 外部サイトからのクロスオリジンリクエスト（Origin が外部 URL や "null"）は拒否する。
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  try {
    const { hostname } = new URL(origin);
    return LOCAL_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Sec-Fetch-Site による cross-site 判定。
 * same-origin（アプリ自身の fetch）と none（アドレスバー入力・ブックマーク等の直接遷移）だけ許可し、
 * cross-site / same-site（他サイトからの <img>/<script>/fetch/リンク）は拒否する。
 * 非ブラウザ（curl・MCP クライアント）や Sec-Fetch 非対応の古いブラウザはヘッダ未送信 →
 * その場合は Host/Origin 判定へフォールバック（undefined は許可）。
 */
export function isAllowedFetchSite(secFetchSite: string | undefined): boolean {
  if (secFetchSite === undefined || secFetchSite === '') return true;
  return secFetchSite === 'same-origin' || secFetchSite === 'none';
}

/**
 * /api・/mcp へのリクエストを通してよいか。
 * Host（loopback）・Origin（未指定/ローカルのみ）・Sec-Fetch-Site（cross-site 拒否）の全てを満たすこと。
 * req.headers をそのまま渡す（テスト容易性のため個別値も受けられるオーバーロードにしない）。
 */
export function isAllowedLocalRequest(headers: {
  host?: string | string[];
  origin?: string | string[];
  'sec-fetch-site'?: string | string[];
}): boolean {
  const host = headerValue(headers.host);
  const origin = headerValue(headers.origin);
  const secFetchSite = headerValue(headers['sec-fetch-site']);
  // 重複ヘッダ（配列）はいずれも不許可＝リクエスト拒否（fail-closed）。
  if (host === DUPLICATE || origin === DUPLICATE || secFetchSite === DUPLICATE) return false;
  return isLocalHostHeader(host) && isAllowedOrigin(origin) && isAllowedFetchSite(secFetchSite);
}

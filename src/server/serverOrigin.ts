/**
 * plugin 起動時に記録する実 origin（M2c T3・設計判断7）。
 *
 * 「Host ヘッダ推測はしない」——撮影ドライバ（captureDriver）に渡す serverUrl は、
 * Vite の httpServer が実際に listen したアドレスから直接組み立てる。plugin.ts の
 * configureServer が listen 後にここへ記録し、サーバ側の他モジュールは
 * getServerOrigin() で読み出す（実配線は T5 の責務）。
 *
 * モジュール内の可変状態は単一の dev サーバプロセスに対して1つだけ持つ想定
 * （複数 origin の同時記録は要らない）。
 */
let recordedOrigin: string | null = null;

/** node:net の SocketAddress 相当（listen 後の httpServer.address() の形）。 */
export interface ListenAddress {
  address: string;
  port: number;
}

/**
 * listen アドレスから origin 文字列を組み立てる（純粋関数・テスト容易性のため分離）。
 * 0.0.0.0 / :: （全インターフェース bind）は撮影ドライバがそのまま接続できないため、
 * ローカル撮影用に 127.0.0.1 へ丸める。
 */
export function originFromAddress(address: ListenAddress | null): string | null {
  if (address === null) return null;
  const host = address.address === '0.0.0.0' || address.address === '::' ? '127.0.0.1' : address.address;
  // IPv6 リテラル（`:` を含む・0.0.0.0/::丸め後の 127.0.0.1 は該当しない）は URL 上
  // `[host]:port` と角括弧で囲む必要がある（M-3）。囲まないと `http://::1:5173` のように
  // ホスト部とポート区切りの `:` が IPv6 のコロンと区別できず、URL として不正になる。
  const hostForUrl = host.includes(':') ? `[${host}]` : host;
  return `http://${hostForUrl}:${address.port}`;
}

/** 記録する（未起動 / 停止時は null）。 */
export function setServerOrigin(value: string | null): void {
  recordedOrigin = value;
}

/** サーバ側モジュールが撮影に渡す origin を取得する口。未起動は null。 */
export function getServerOrigin(): string | null {
  return recordedOrigin;
}

/** plugin.ts の configureServer が渡す httpServer の面（最小限）。 */
export interface OriginAwareHttpServer {
  listening: boolean;
  address(): unknown;
  once(event: 'listening', listener: () => void): void;
}

/**
 * listen 後に origin を記録する配線本体（plugin.ts から呼ぶ）。EventEmitter への依存を
 * listening/address/once の3面だけに絞って抽出したのは、テストで実 http.Server を起動せずに
 * フック注入で配線を検証できるようにするため（M2c T3 追補・レビュー Minor③）——
 * この関数自体を fake httpServer で直接駆動して pin する（serverOrigin.test.ts）。
 * httpServer が無い（Vite のミドルウェアモード等）場合は null に倒す。
 */
export function wireServerOrigin(httpServer: OriginAwareHttpServer | null | undefined): void {
  if (!httpServer) {
    setServerOrigin(null);
    return;
  }
  const recordOrigin = (): void => {
    const address = httpServer.address();
    setServerOrigin(address !== null && typeof address === 'object' ? originFromAddress(address as ListenAddress) : null);
  };
  if (httpServer.listening) recordOrigin();
  httpServer.once('listening', recordOrigin);
}

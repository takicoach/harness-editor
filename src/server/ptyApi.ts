/**
 * /api/pty — pty への WebSocket 口と接続制御。
 * 脅威モデル: pty 入力＝任意コード実行相当（スペック「セキュリティ」）。
 * 防御: (1) upgrade 時に Host + Origin を検証（同一オリジン判定・ポート決め打ちしない。
 *           Origin の host:port が Host ヘッダと完全一致し、かつ Host がループバックで
 *           scheme が http: の時のみ許可。WS は Origin 必須）
 *       (2) 短寿命・一回限りトークンを接続後の最初のメッセージで照合（照合前は pty 非接続）
 *       (3) 書き込み接続は常に1本（新接続が来たら旧接続へ takeover を送り、message/close
 *           ハンドラを明示的に外した上で terminate() する。close() は相手の Close frame
 *           受信/エラーまで最大30秒 receiver を動かし続け、その間 message ハンドラも
 *           生きて pty に書き込めてしまう（ws@8.21.1）ため使わない。加えて message
 *           ハンドラ自体も「自分が現在の writer か」を毎回ガードする二重防御）
 *       (4) input は 1 メッセージ 8192 文字まで・認証前接続は最大 4 本
 *           （pendingCount は実際に ws が生成された後だけ増やす — handleUpgrade が
 *           ハンドシェイク不正でコールバックを呼ばずに abort する経路での恒久リークを防ぐ）
 *       (5) WebSocketServer に maxPayload を設定し巨大フレーム・圧縮爆弾を拒否する
 *       (6) 書き込み接続は接続時の pty sessionId に束縛する。ツール切替（switchTool）で
 *           pty が入れ替わったあと、旧タブの writer が新しいツールへ入力するのを防ぐ
 *           （外部レビューが「最も危険な1点」とした経路）。不一致なら stale を送って切断する
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { isLocalHostHeader } from './localGuard';
import { ptySessions } from './ptySession';

const TOKEN_TTL_MS = 30_000;
const MAX_INPUT_CHARS = 8192;
const MAX_PENDING_CONNS = 4;
/** input 上限(8192文字)＋auth メッセージに十分な上限。巨大フレーム・圧縮展開を弾く。 */
const MAX_WS_PAYLOAD_BYTES = 65536;

/**
 * WS の Origin を「リクエスト自身の Host ヘッダとの同一オリジン」で判定する（ポート決め打ちしない）。
 * ポートを決め打ちすると、ユーザーが別ポートで起動しただけで pty が壊れ、
 * e2e も本番と別ポートで走らせざるを得ない（ブラウザは Origin を偽装できないため
 * 本番経路を検証できなくなる）。同一オリジン判定ならどのポートでも安全に動く。
 * すべて満たす時のみ許可: Host がループバック / Origin が存在する（ブラウザの WS は必ず
 * 送る＝未指定は非ブラウザとして拒否） / Origin の scheme が http: / Origin の host（host:port
 * 込み）が Host ヘッダと完全一致する。
 */
export function isAllowedWsOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return false;
  if (!isLocalHostHeader(host)) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && parsed.host === host;
}

export function createPtyTokenStore(ttlMs: number = TOKEN_TTL_MS) {
  const tokens = new Map<string, number>(); // token → 期限 epoch ms
  return {
    issue(): string {
      const t = randomUUID();
      tokens.set(t, Date.now() + ttlMs);
      return t;
    },
    consume(token: string): boolean {
      const exp = tokens.get(token);
      if (exp === undefined) return false;
      tokens.delete(token); // 一回限り（成否に関わらず消す）
      return Date.now() <= exp;
    },
  };
}

export const ptyTokens = createPtyTokenStore();

let wss: WebSocketServer | null = null;
let writer: WebSocket | null = null; // 認証済みの唯一の書き込み接続
/** 現在の writer に登録した message/close ハンドラを外す関数（takeover 時の二重防御その1）。 */
let writerCleanup: (() => void) | null = null;
let pendingCount = 0;
let detachData: (() => void) | null = null;
let detachExit: (() => void) | null = null;
/** 現在の writer が接続した時点の pty sessionId（切替検出用）。 */
let boundSessionId: string | null = null;

function attachWriter(ws: WebSocket): void {
  const prevWriter = writer;
  const prevCleanup = writerCleanup;
  if (prevWriter !== null) {
    // 二重防御その1: 旧 writer の message/close ハンドラを明示的に外す。
    prevCleanup?.();
    if (prevWriter.readyState === WebSocket.OPEN) {
      prevWriter.send(JSON.stringify({ type: 'takeover' }));
      // 二重防御その2: close() ではなく terminate() で即時にソケットを切断する。
      // close() は相手の Close frame 受信/エラーまで最大30秒 receiver を動かし続け
      // （ws@8.21.1 の closeTimeout 既定値）、その間は message ハンドラも生きたまま
      // なので、二重接続状態のまま旧 writer から pty に書き込めてしまう（RCE 相当）。
      prevWriter.terminate();
    }
  }
  detachData?.();
  detachExit?.();
  writer = ws;
  boundSessionId = ptySessions.sessionId();
  writerCleanup = null;
  ws.send(JSON.stringify({ type: 'scrollback', data: ptySessions.scrollback() }));
  ws.send(JSON.stringify({ type: 'removed-env', keys: ptySessions.removedEnvKeys() }));
  detachData = ptySessions.onData((chunk) => {
    // 生出力も JSON フレームで包む。裸のまま送ると、pty 出力がたまたま
    // `{"type":"exit"}` 等の制御 JSON と同一のチャンクになったとき、クライアントが
    // 制御メッセージと識別できず接続状態を偽装されうる（codex-review 2026-08-03 指摘）。
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data: chunk }));
  });
  detachExit = ptySessions.onExit((code) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'exit', code }));
  });
  const onMessage = (raw: WebSocket.RawData): void => {
    // 主防御その1: close() の30秒猶予中に旧 ws の message ハンドラが生き残っていても、
    // 自分が現在の writer でなければ何もしない（takeover 後の書き込み継続を防ぐ）。
    if (ws !== writer) return;
    // 主防御その2: 接続時と pty の sessionId が違う＝間にツール切替が入った。
    // そのまま書くと「Claude に向けて打った内容が Codex に入る」ため、切断して知らせる。
    if (boundSessionId !== ptySessions.sessionId()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stale' }));
      writerCleanup?.();
      ws.terminate();
      if (writer === ws) {
        writer = null;
        writerCleanup = null;
        boundSessionId = null;
        detachData?.();
        detachExit?.();
        detachData = null;
        detachExit = null;
      }
      return;
    }
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string' && msg.data.length <= MAX_INPUT_CHARS) {
      ptySessions.write(msg.data);
    } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
      ptySessions.resize(msg.cols, msg.rows);
    }
  };
  const onClose = (): void => {
    ws.off('message', onMessage);
    ws.off('close', onClose);
    if (writer === ws) {
      writer = null;
      writerCleanup = null;
      boundSessionId = null;
      detachData?.();
      detachExit?.();
      detachData = null;
      detachExit = null;
    }
  };
  ws.on('message', onMessage);
  ws.on('close', onClose);
  writerCleanup = () => {
    ws.off('message', onMessage);
    ws.off('close', onClose);
  };
}

/** httpServer の 'upgrade' に配線する。/api/pty 以外のソケットには一切触れない（HMR 保護）。 */
export function handlePtyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/api/pty') return; // 他パス（Vite HMR 等）は素通し
  const host = Array.isArray(req.headers.host) ? undefined : req.headers.host;
  const origin = Array.isArray(req.headers.origin) ? undefined : req.headers.origin;
  if (!isAllowedWsOrigin(origin, host) || pendingCount >= MAX_PENDING_CONNS) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss ??= new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES, perMessageDeflate: false });
  wss.handleUpgrade(req, socket, head, (ws) => {
    // maxPayload 超過等のプロトコルエラーは ws が close(1009) を送った後に 'error' を
    // emit する。リスナーが無いと Node の EventEmitter既定動作で未捕捉例外＝プロセス
    // クラッシュになるため、no-op でも必ず受け止める（close 済みなので追加処理は不要）。
    ws.on('error', () => {});
    // pendingCount は「実際に ws が生成された後」だけ増やす。handleUpgrade が
    // ハンドシェイク不正（Sec-WebSocket-Key 欠落等）でこのコールバックを呼ばずに
    // abort する経路では ++ 自体が起きないため、恒久リーク（4回で 403 固定）を防ぐ。
    pendingCount++;
    // 認証: 最初のメッセージが 5 秒以内に {type:'auth',token} で来なければ切断。
    // settled は「pendingCount の decrement を必ず一度だけ」行うためのガード
    // （タイムアウト発火と message 到達が競合しても二重に減らさない）。
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingCount--;
      ws.close();
    }, 5000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      pendingCount--;
      let msg: { type?: string; token?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        ws.close();
        return;
      }
      if (msg.type !== 'auth' || typeof msg.token !== 'string' || !ptyTokens.consume(msg.token)) {
        ws.send(JSON.stringify({ type: 'auth-failed' }));
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: 'auth-ok' }));
      attachWriter(ws);
    });
  });
}

/**
 * 現在の writer を即座に失効させる（ツール切替の第1手順）。
 * close() ではなく terminate() を使う理由は attachWriter のコメントと同じ
 * （close() は最大30秒 receiver を動かし続け、その間 message ハンドラが生きる）。
 */
export function invalidateWriter(): void {
  const prev = writer;
  writerCleanup?.();
  writerCleanup = null;
  writer = null;
  boundSessionId = null;
  detachData?.();
  detachExit?.();
  detachData = null;
  detachExit = null;
  if (prev !== null && prev.readyState === WebSocket.OPEN) {
    prev.send(JSON.stringify({ type: 'stale' }));
    prev.terminate();
  }
}

// ptySession から ptyApi を import すると循環するため、注入で結ぶ。
ptySessions.setInvalidateWriter(invalidateWriter);

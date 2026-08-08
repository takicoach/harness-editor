/**
 * GET /api/events(?id=<projectId>) — SSE 1 本統合エンドポイント。
 *
 * 背景: 従来はタブ 1 枚あたり SSE を最大 8 本（projects/watch・watch・instructions/stream・
 * render/denoise/normalize/preview-proxy/transcribe の GET）張っており、2 タブ開くと
 * Chrome の HTTP/1.1 同一オリジン同時接続上限（6 本）を使い切り、他の fetch（動画読込・
 * 保存・pack-upgrade 等）が止まる実害があった（2026-07-23 実機）。
 *
 * 対応: 1 接続に全チャネルを多重化する。メッセージ形式は
 * `data: {"ch":"<channel>","msg":<従来ペイロードそのまま>}\n\n`。
 * 従来の各エンドポイントが送っていた JSON を無変更で msg に包むので、クライアント側の
 * 既存パーサ・状態機械（nextRenderState 等）はそのまま使い回せる。
 *
 * id 無し（ホーム画面）: projects チャネルのみ。
 * id 有り（エディタ画面）: projects・watch・claude・render・denoise・normalize・
 * preview-proxy・transcribe の全チャネル。
 *
 * ## GET /api/events/sync?id=<projectId>&ch=<channel>（キャッチアップ用・2026-07-23 追加）
 *
 * 統合バスは main.tsx で張りっぱなしのため、バス接続が確立した「後」にマウント/リマウント
 * したコンシューマ（例: プロジェクト再読込で unmount→remount する `TranscriptPanel` 配下の
 * `useNormalize`/`useDenoise`/`usePreviewProxy`、初回マウントの `ClaudePanel`/`useRenderJob`）は、
 * 接続時に一度きり配られる初期スナップショット（idle/snapshot・claude の初期一覧）を
 * 受け取れない（バスは過去メッセージを再送しない）。
 * この欠落を埋めるため、「今つなぎ直したら最初に届くはずのメッセージ列」を単発 GET で
 * 返す。クライアントはマウント時（projectId 変更時）にこれを fetch し、既存の
 * メッセージ処理経路（`nextRenderState` 等の reducer）へ順に流し込んでから、以降はバス購読
 * に委ねる。sync とバスイベントの順序レースは snapshot が正なので許容する
 * （旧・接続ごと EventSource 方式でも同様のレースはあった）。
 * 対象 ch: `claude`/`render`/`denoise`/`normalize`/`preview-proxy`/`transcribe`。
 * `projects`/`watch` は対象外（`useProjectsWatch` は初期 REST fetch を別途持つ・
 * `watch` は「外部変更フラグ」のみで保持すべき初期状態が無い）。
 * **sync は読み取り専用**（M-1・2026-07-23 追補）: terminal ジョブの snapshot を返す場合も
 * discard しない。terminal ジョブの破棄は接続時 wireJobChannel の初期送信分岐と、
 * ライブイベント経路（subscribe コールバック）の 2 箇所だけに集約する
 * （sync がもう1箇所の破棄経路になると、複数タブから同時に sync が飛んだ場合に
 * どちらが「観測者」だったか曖昧になり、接続中の wireJobChannel 側が discard 済みの
 * ジョブを見て取りこぼす競合を生みうるため）。
 *
 * 設計書: docs/specs/2026-07-23-sse-unified-connection.md
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './http';
import { resolveProjectDir } from './projectRoot';
import { watchProject } from './watchProject';
import { watchAllProjectsStatus } from './projectsWatch';
import { isSelfWriting, clearSelfWrite } from './selfWrite';
import { instructionInbox } from './instructionInbox';
import { renderJobs } from './renderApi';
import { denoiseJobs } from './denoiseApi';
import { normalizeJobs } from './normalizeApi';
import { previewProxyJobs } from './previewProxyApi';
import { transcribeJobs } from './transcribeApi';

const HEARTBEAT_MS = 25_000;

/** ジョブ系チャネル（render/denoise/normalize/preview-proxy/transcribe）が共通で持つ形。 */
interface JobLike {
  phase: string;
  error?: { code: string; message: string };
}

/** ジョブ系 Manager（RenderJobManager 等）が共通で持つ、SSE 配信に必要な最小インターフェース。 */
interface JobManagerLike<J extends JobLike, E extends JobLike> {
  get(projectId: string): J | undefined;
  subscribe(projectId: string, fn: (ev: E) => void): () => void;
  discard(projectId: string): void;
}

/** ジョブの phase が終端（これ以上イベントが来ない）かどうか。 */
function isTerminalPhase(phase: string): boolean {
  return phase === 'done' || phase === 'failed' || phase === 'cancelled' || phase === 'completed';
}

/**
 * ジョブ系チャネルの「今つないだら最初に届くはずのメッセージ列」を**読み取り専用**で
 * 計算する（discard しない）。wireJobChannel の接続時初期送信と sync エンドポイントの
 * 両方が使う共通ロジック。terminal ジョブの破棄は呼び出し側の責務（M-1: sync 側は
 * 読み取り専用にし、破棄は接続時 wireJobChannel／ライブイベント経路の2箇所に集約する）。
 */
function jobChannelMessages<J extends JobLike>(
  projectId: string,
  manager: { get(projectId: string): J | undefined },
): unknown[] {
  const job = manager.get(projectId);
  if (!job) return [{ type: 'idle' }];
  const messages: unknown[] = [{ type: 'snapshot', job }];
  if (isTerminalPhase(job.phase)) {
    messages.push({ type: 'done', phase: job.phase, error: job.error });
  }
  return messages;
}

/**
 * ジョブ系チャネル 1 本を配線する。従来ハンドラ（handleRenderSse 等）と同じ
 * idle/snapshot/event/done セマンティクスを踏襲しつつ、統合接続は張りっぱなしにする。
 *
 * 重要な差分（スペック注意 1）: terminal（done/failed/cancelled/completed）を観測しても
 * 接続は閉じない。
 *
 * 破棄（discard）呼び出しは 2 箇所のみ（M-1）:
 *  1. 接続時点で既に terminal だったジョブの観測時（このコードの下の分岐）
 *  2. subscribe 中にライブで terminal を観測した時（このコードの subscribe コールバック内）
 * sync エンドポイント（jobChannelMessages/handleEventsSync）は discard しない。
 *
 * subscribe は接続の生存期間中 1 回だけ行う（I-1 修正前は Manager の cleanup() が
 * subs.delete(projectId) で購読者 Set ごと消していたため、terminal 観測のたびに
 * unsubscribe→再 subscribe するハックが必要だった。5 Manager 全ての cleanup() から
 * subs 削除を外し、購読解除は subscribe() が返す unsubscribe 関数だけが行うように
 * 修正済みのため、1 回の subscribe が次のジョブの emit も引き続き受け取れる。
 * 2 接続が同一 projectId を subscribe している状態で、片方の emit ループが discard→
 * 再 subscribe すると、その反復中の Set 変更がもう片方の購読者を巻き込んで消してしまう
 * 再入バグがあったため、このハック自体を廃止した）。
 */
function wireJobChannel<J extends JobLike, E extends JobLike>(
  ch: string,
  projectId: string,
  manager: JobManagerLike<J, E>,
  send: (ch: string, msg: unknown) => void,
): () => void {
  const job = manager.get(projectId);
  if (!job) {
    send(ch, { type: 'idle' });
  } else {
    send(ch, { type: 'snapshot', job });
    if (isTerminalPhase(job.phase)) {
      send(ch, { type: 'done', phase: job.phase, error: job.error });
      manager.discard(projectId);
    }
  }

  return manager.subscribe(projectId, (ev) => {
    send(ch, { type: 'event', event: ev });
    if (isTerminalPhase(ev.phase)) {
      send(ch, { type: 'done', phase: ev.phase, error: ev.error });
      manager.discard(projectId);
    }
  });
}

/** projects チャネル（ホーム・サイドバーのライブ更新）を配線する。 */
function wireProjectsChannel(root: string, send: (ch: string, msg: unknown) => void): () => void {
  send('projects', { type: 'open' });
  try {
    return watchAllProjectsStatus(root, (event) => {
      send('projects', { type: 'status', ...event });
    });
  } catch (err) {
    // 従来同様: 初期化失敗はログのみ・接続全体は殺さない（スペック注意 5）。
    console.error('[sme] events: projects チャネル初期化失敗:', err);
    return () => {};
  }
}

/** watch チャネル（開いているプロジェクトの外部変更検知）を配線する。 */
function wireWatchChannel(root: string, projectId: string, send: (ch: string, msg: unknown) => void): () => void {
  send('watch', { type: 'open' });
  try {
    const dir = resolveProjectDir(root, projectId);
    return watchProject(
      dir,
      () => send('watch', { type: 'change' }),
      { isSelfWrite: () => isSelfWriting(projectId) },
    );
  } catch (err) {
    console.error('[sme] events: watch チャネル初期化失敗:', err);
    return () => {};
  }
}

/** claude チャネルの「今つないだら最初に届くはずのメッセージ列」（sync と共用）。 */
function claudeChannelSnapshot(projectId: string): unknown[] {
  return instructionInbox.list(projectId).map((record) => ({ type: 'update', record }));
}

/** claude チャネル（AI タブの指示履歴ライブ更新）を配線する。 */
function wireClaudeChannel(projectId: string, send: (ch: string, msg: unknown) => void): () => void {
  send('claude', { type: 'open' });
  for (const msg of claudeChannelSnapshot(projectId)) send('claude', msg);
  return instructionInbox.subscribe((record) => {
    if (record.projectId === projectId) {
      send('claude', { type: 'update', record });
    }
  });
}

/** sync 対象チャネル → スナップショット計算関数（すべて読み取り専用・discard しない）。 */
const SYNC_CHANNELS: Record<string, (projectId: string) => unknown[]> = {
  claude: claudeChannelSnapshot,
  render: (id) => jobChannelMessages(id, renderJobs),
  denoise: (id) => jobChannelMessages(id, denoiseJobs),
  normalize: (id) => jobChannelMessages(id, normalizeJobs),
  'preview-proxy': (id) => jobChannelMessages(id, previewProxyJobs),
  transcribe: (id) => jobChannelMessages(id, transcribeJobs),
};

/**
 * GET /api/events/sync?id=<projectId>&ch=<channel> のハンドラ本体。
 * 対象は SYNC_CHANNELS のキーのみ（projects/watch は非対応・上記コメント参照）。
 */
export function handleEventsSync(projectId: string, ch: string): { messages: unknown[] } {
  const compute = SYNC_CHANNELS[ch];
  if (!compute) {
    throw new HttpError(400, `sync 非対応のチャネルです: ${ch}`);
  }
  return { messages: compute(projectId) };
}

/** GET /api/events(?id=<projectId>) のハンドラ。 */
export function handleEventsSse(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  projectId: string | null,
): void {
  // projectId のバリデーション（パストラバーサル等）はここでは行わない。resolveProjectDir
  // を呼ぶのは wireWatchChannel だけで、そこは try/catch で HttpError を握って watch
  // チャネルの初期化だけ諦め、接続自体は維持する（他チャネルへ影響させない・スペック注意 5）。
  // projects/claude/ジョブ系チャネルは projectId を Manager のキーとして使うだけで
  // FS には触れないため、不正な id でも単に「該当データが無い」扱いになるだけで安全。
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const safeWrite = (chunk: string): void => {
    if (!res.writableEnded) res.write(chunk);
  };
  const send = (ch: string, msg: unknown): void => {
    safeWrite(`data: ${JSON.stringify({ ch, msg })}\n\n`);
  };

  const stops: Array<() => void> = [];
  stops.push(wireProjectsChannel(root, send));

  if (projectId !== null) {
    stops.push(wireWatchChannel(root, projectId, send));
    stops.push(wireClaudeChannel(projectId, send));
    stops.push(wireJobChannel('render', projectId, renderJobs, send));
    stops.push(wireJobChannel('denoise', projectId, denoiseJobs, send));
    stops.push(wireJobChannel('normalize', projectId, normalizeJobs, send));
    stops.push(wireJobChannel('preview-proxy', projectId, previewProxyJobs, send));
    stops.push(wireJobChannel('transcribe', projectId, transcribeJobs, send));
  }

  const heartbeat = setInterval(() => safeWrite(': heartbeat\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    for (const stop of stops) stop();
    if (projectId !== null) clearSelfWrite(projectId);
    res.end();
  });
}

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
 * 契約: SSE は**この 1 本へ統合**する。新しい通知が要るときは新エンドポイントを
 * 足すのではなく、このイベント経路のチャネルを増やす。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './http';
import { resolveProjectDir } from './projectRoot';
import { watchProject } from './watchProject';
import { watchAllProjectsStatus } from './projectsWatch';
import { isSelfWriting, isSelfWriteContent, selfWriteRemainingMs, clearSelfWrite } from './selfWrite';
import { projectContentSignature } from './projectWatchPaths';
import { instructionInbox } from './instructionInbox';
import { renderJobs,restoreRenderJobs } from './renderApi';
import { denoiseJobs } from './denoiseApi';
import { normalizeJobs } from './normalizeApi';
import { previewProxyJobs } from './previewProxyApi';
import { transcribeJobs } from './transcribeApi';
import { sequenceService } from './sequence/service';

const HEARTBEAT_MS = 25_000;

/**
 * 診断ログ（既定 OFF・`SME_DEBUG_EVENTS=1` で ON）。
 *
 * 間欠赤の切り分けに必須の情報がこれまで**どこにも残っていなかった**: ライブ更新が
 * 出ない失敗を見ても、「サーバが status を送らなかった」のか「送ったがクライアントが
 * 落とした」のかを区別できず、原因未特定のまま閉じるしかなかった（E-2 差し戻し）。
 * 送信側の事実だけでも記録が残れば、この二択は必ず割れる。
 * 通常運用では黙る（e2e は playwright 設定が env で ON にする）。
 */
const DEBUG_EVENTS = process.env.SME_DEBUG_EVENTS === '1';

/** ジョブ系チャネル（render/denoise/normalize/preview-proxy/transcribe）が共通で持つ形。 */
interface JobLike {
  phase: string;
  error?: { code: string; message: string };
  warning?: string;
}

function terminalMessage(job: JobLike): unknown {
  return {
    type: 'done', phase: job.phase, error: job.error,
    ...(job.warning === undefined ? {} : { warning: job.warning }),
  };
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
    messages.push(terminalMessage(job));
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
  restore?:()=>Promise<unknown[]>,
): () => void {
  if(restore){
    let closed=false,received=false;
    const stop=manager.subscribe(projectId,ev=>{received=true;send(ch,{type:'event',event:ev});if(isTerminalPhase(ev.phase)){send(ch,terminalMessage(ev));manager.discard(projectId);}});
    // Subscribe before starting restoration; a newer live event wins over a delayed snapshot.
    void restore().then(messages=>{if(!closed&&!received)for(const message of messages)send(ch,message);}).catch(error=>{
      if(!closed&&!received)send(ch,terminalMessage({phase:'failed',error:{code:'restore-failed',message:String(error)}}));
    });
    return ()=>{closed=true;stop();};
  }
  const job = manager.get(projectId);
  if (!job) {
    send(ch, { type: 'idle' });
  } else {
    send(ch, { type: 'snapshot', job });
    if (isTerminalPhase(job.phase)) {
      send(ch, terminalMessage(job));
      manager.discard(projectId);
    }
  }

  return manager.subscribe(projectId, (ev) => {
    send(ch, { type: 'event', event: ev });
    if (isTerminalPhase(ev.phase)) {
      send(ch, terminalMessage(ev));
      manager.discard(projectId);
    }
  });
}

/** projects チャネル（ホーム・サイドバーのライブ更新）を配線する。 */
function wireProjectsChannel(root: string, send: (ch: string, msg: unknown) => void): () => void {
  send('projects', { type: 'open' });
  try {
    return watchAllProjectsStatus(root, (event) => {
      if (DEBUG_EVENTS) {
        console.log(
          `[sme] events: projects status id=${event.id} activity=${String(event.activityLabel)}`,
        );
      }
      send('projects', { type: 'status', ...event });
    });
  } catch (err) {
    // 従来同様: 初期化失敗はログのみ・接続全体は殺さない（スペック注意 5）。
    console.error('[sme] events: projects チャネル初期化失敗:', err);
    return () => {};
  }
}

/** watch チャネル（開いているプロジェクトの外部変更検知）を配線する。 */
function wireWatchChannel(
  root: string,
  projectId: string,
  send: (ch: string, msg: unknown) => void,
  writerId?: string,
): () => void {
  send('watch', { type: 'open' });
  try {
    const dir = resolveProjectDir(root, projectId);
    return watchProject(
      dir,
      () => send('watch', { type: 'change' }),
      {
        isSelfWrite: () => isSelfWriting(projectId, writerId),
        selfWriteRemainingMs: () => selfWriteRemainingMs(projectId, writerId),
        // 窓明けの再評価は内容で判定する。ディスクが「この画面が保存した姿」のままなら
        // 自分の書込＝通知しない。別画面の保存は writerId が違うのでここでも通らない。
        isSelfContent: () => isSelfWriteContent(projectId, writerId, projectContentSignature(dir)),
      },
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
const renderObservations = {
  get: (id: string) => renderJobs.getSnapshot(id),
  subscribe: (id:string,listener:Parameters<typeof renderJobs.subscribe>[1]) => renderJobs.subscribe(id,listener),
  discard: (id: string) => renderJobs.discard(id),
};
/** Invalid/missing project IDs retain the existing idle-channel behavior. */
export async function restoreRenderObservations(root:string,projectId:string):Promise<unknown[]> {
  let directory:string;
  try{directory=resolveProjectDir(root,projectId);}catch(error){if(error instanceof HttpError)return [{type:'idle'}];return [terminalMessage({phase:'failed',error:{code:'restore-failed',message:String(error)}})];}
  try{await restoreRenderJobs(projectId,directory);return jobChannelMessages(projectId,renderObservations);}
  catch(error){console.error('[sme] events: render 履歴の復元失敗:',error);return [terminalMessage({phase:'failed',error:{code:'restore-failed',message:'書き出し履歴を確認できません。保存先を確認して再接続してください。'}})];}
}
const SYNC_CHANNELS: Record<string, (projectId: string) => unknown[]> = {
  claude: claudeChannelSnapshot,
  render: (id) => jobChannelMessages(id, renderObservations),
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
  /** この接続を開いた画面の識別子（?w=…）。同じ画面の保存だけを suppress する（data-safety-5）。 */
  writerId?: string,
  /** Production restores persisted render state after the other channels are connected. */
  restoreRender?:()=>Promise<unknown[]>,
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
    stops.push(wireWatchChannel(root, projectId, send, writerId));
    try {
      stops.push(sequenceService.subscribe(resolveProjectDir(root, projectId), () => send('sequence', { type: 'change' })));
      send('sequence', { type: 'open' });
    } catch { /* Missing projects still receive the established watch/error handling. */ }
    stops.push(wireClaudeChannel(projectId, send));
    stops.push(wireJobChannel('render', projectId, renderObservations, send,restoreRender));
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

import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { sendJson, HttpError } from './http';
import { readBodyText } from './readBody';
import { MockRenderJobManager } from './mockRenderJob';
import { parseRenderOptions, renderOutputName } from '../shared/renderPreset';
import { heavyJobGate, heavyJobCounts } from './systemLoad';
import { assertLegacySequenceAuthority } from './sequence/authority';
import {LegacyNativeRenderJobs} from './legacyNativeRenderJobs';

/** レンダーのプリセットオプション body の上限（数 KB で足りる。巨大 body を弾く）。 */
const RENDER_BODY_MAX_BYTES = 1024 * 1024;

/** tmp 出力ファイル名。projectId のパス区切りはサニタイズ（ネスト id で別階層に書かない）。 */
export function tmpOutputName(projectId: string, now: number): string {
  return `.sme-render-tmp-${projectId.replace(/[\\/]/g, '_')}-${now}.mp4`;
}

/** プロジェクト共通の Manager。plugin.ts で 1 個だけ生成して使う。 */
export const renderJobs = process.env.SME_RENDER_MOCK === '1'
  ? new MockRenderJobManager(
      Number(process.env.SME_RENDER_MOCK_DELAY_MS ?? '3000'),
      process.env.SME_RENDER_MOCK_FAIL === '1',
    )
  : new LegacyNativeRenderJobs();

/** Restore persisted observations for reconnect, sync and reveal. */
export async function restoreRenderJobs(projectId:string,projectDir:string):Promise<void> {
  if(renderJobs instanceof LegacyNativeRenderJobs)await renderJobs.restore(projectId,projectDir);
}
export function reconcileRenderJobs(projectId:string,projectDir:string):void {
  if(renderJobs instanceof LegacyNativeRenderJobs)renderJobs.reconcile(projectId,projectDir);
}

/**
 * OS ごとの「フォルダを開いてファイルを選択」コマンドを組み立てて起動する。
 * fire-and-forget: stdio は無視・unref で親から切り離し・エラーは on('error') で握る。
 * テスト容易性のため spawnFn を注入可能にしている。
 */
export function revealInFinder(
  path: string,
  platform: NodeJS.Platform,
  spawnFn: typeof nodeSpawn = nodeSpawn,
): void {
  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = ['-R', path];
  } else if (platform === 'win32') {
    command = 'explorer';
    args = ['/select,' + path];
  } else {
    command = 'xdg-open';
    args = [dirname(path)];
  }
  const child = spawnFn(command, args, { stdio: 'ignore' });
  // spawn 失敗（コマンド未存在など）で開発サーバを落とさないよう握りつぶす。
  child.on('error', () => { /* ignore reveal failures */ });
  child.unref();
}

/**
 * POST /api/render?id=<projectId>
 *
 * - 旧編集形式の固定snapshotから独自書き出しを開始する。
 * - 同時実行は 1 本のみ（409 で弾く）。
 * - 一時出力は最終出力と同一ディレクトリ（out/）・ドット始まりで置く。
 */
export async function handleRenderPost(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
  force = false,
  /**
   * mock 書き出し（SME_RENDER_MOCK=1）でだけ効くテスト用スイッチ（?mockWarning=1）。
   * 旧通知を含め、通知が2つ同時に出た時の表示を実ブラウザで検査する。
   * 通常の独自書き出しでは使わない。
   */
  mockWarning = false,
): Promise<void> {
  assertLegacySequenceAuthority(projectDir);
  reconcileRenderJobs(projectId,projectDir);
  if (renderJobs.exists(projectId)) {
    sendJson(res, 409, { error: 'already-running' });
    return;
  }

  const gate = heavyJobGate(force, { counts: heavyJobCounts() });
  if (!gate.allowed) {
    sendJson(res, 409, {
      error: 'confirmation-required',
      confirmationRequired: true,
      running: gate.running,
      recommendedMax: gate.recommendedMax,
    });
    return;
  }

  // body はプリセットオプション（省略可・空 body は既定値 = 後方互換）。
  // オプションは数 KB で足りるので小さめの上限で読む（巨大 body によるメモリ枯渇の防止）。
  let bodyText: string;
  try {
    bodyText = await readBodyText(req, RENDER_BODY_MAX_BYTES);
  } catch (err) {
    // サイズ超過（HttpError 413）と受信失敗（切断等）を区別してラベルする。
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: 'render-body-too-large' });
    } else {
      sendJson(res, 400, { error: 'render-body-read-failed' });
    }
    return;
  }
  let bodyValue: unknown = undefined;
  if (bodyText !== '') {
    try {
      bodyValue = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { error: 'invalid-render-options' });
      return;
    }
  }
  const options = parseRenderOptions(bodyValue);
  if (options === null) {
    sendJson(res, 400, { error: 'invalid-render-options' });
    return;
  }

  const outDir = join(projectDir, 'out');
  const finalOutput = join(outDir, renderOutputName(options));
  if (lstatSync(finalOutput, { throwIfNoEntry: false }) !== undefined) {
    sendJson(res, 409, { error: 'output-exists', message: '同名のファイルがあります。書き出し画面で別のファイル名を指定してください。' });
    return;
  }
  if(renderJobs instanceof LegacyNativeRenderJobs){
    const port=req.socket.localPort;if(!port)throw new HttpError(500,'ローカルサーバーのポートを確認できません');
    const job=renderJobs.start(projectId,{projectDir,origin:`http://127.0.0.1:${port}`,options});
    sendJson(res,200,{ok:true,startedAt:job.startedAt,outputFile:job.outputFile,fastCut:false,native:true});return;
  }
  // The only remaining manager variant is the explicitly selected UI test mock.
  mkdirSync(outDir, { recursive: true });
  const job = renderJobs.start(projectId, { finalOutput });
  if (mockWarning) {
    renderJobs.warn(projectId, '高速書き出しに失敗したため互換(Remotion)経路でやり直しています（時間がかかります）');
  }
  sendJson(res, 200, { ok: true, startedAt: job.startedAt, outputFile: job.outputFile, fastCut: false });
}

/**
 * GET /api/render?id=<projectId> — SSE で進捗をストリーム。
 * deprecated: /api/events(?id=) の render チャネルへ統合済み。
 */
export function handleRenderSse(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const safeWrite = (data: unknown): void => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const safeEnd = (): void => {
    if (!res.writableEnded) res.end();
  };

  const job = renderJobs.getSnapshot(projectId);
  if (!job) {
    safeWrite({ type: 'idle' });
    safeEnd();
    return;
  }
  // snapshot に job.progress を素通しで含める（job オブジェクトごと送る）。
  safeWrite({ type: 'snapshot', job });

  if (job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled') {
    safeWrite({ type: 'done', phase: job.phase, error: job.error, warning: job.warning });
    renderJobs.discard(projectId);
    safeEnd();
    return;
  }

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 25_000);
  const finish = (): void => {
    clearInterval(heartbeat);
    safeEnd();
  };

  const unsub = renderJobs.subscribe(projectId, (ev) => {
    // イベントに progress を素通しで含める（ev ごと送る）。
    safeWrite({ type: 'event', event: ev });
    if (ev.phase === 'done' || ev.phase === 'failed' || ev.phase === 'cancelled') {
      safeWrite({ type: 'done', phase: ev.phase, error: ev.error, warning: ev.warning });
      unsub();
      // Both managers release terminal runs themselves. This observation hook
      // must not discard a later run belonging to the same project.
      renderJobs.discard(projectId);
      finish();
    }
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
}

/** DELETE /api/render?id=<projectId> — 実行中のジョブをキャンセル（破棄）。 */
export function handleRenderDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): void {
  const ok = renderJobs.cancel(projectId);
  if (!ok) {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * POST /api/render/reveal?id=<projectId>
 *
 * 直近に完成した出力を OS のファイラで表示する。無ければ 404。
 */
export function handleRenderReveal(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
  reveal: typeof revealInFinder = revealInFinder,
): void {
  const job = renderJobs.getSnapshot(projectId);
  if (job && job.phase !== 'done') {
    sendJson(res, 409, { error: 'output-not-complete' });
    return;
  }
  const outputFile = job?.outputFile ?? 'video.mp4';
  if (basename(outputFile) !== outputFile) {
    sendJson(res, 404, { error: 'no-output' });
    return;
  }
  const outputPath = join(projectDir, 'out', outputFile);
  if (!existsSync(outputPath)) {
    sendJson(res, 404, { error: 'no-output' });
    return;
  }
  // fire-and-forget: spawn の成否を待たずに 200 を返す。
  reveal(outputPath, process.platform);
  sendJson(res, 200, { ok: true });
}

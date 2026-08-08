import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { sendJson, HttpError } from './http';
import { readBodyText } from './readBody';
import { RenderJobManager, createMockRenderDeps } from './renderJob';
import { parseRenderOptions, postScaleArgs, renderExtraArgs, renderOutputName } from '../shared/renderPreset';
import { heavyJobGate, heavyJobCounts } from './systemLoad';
import { planFastCut } from './fastCutPlan';
import { resolveFfmpegBin } from './resolveFfmpeg';
import { projectResolution } from './projectResolution';

/** レンダーのプリセットオプション body の上限（数 KB で足りる。巨大 body を弾く）。 */
const RENDER_BODY_MAX_BYTES = 1024 * 1024;

/** tmp 出力ファイル名。projectId のパス区切りはサニタイズ（ネスト id で別階層に書かない）。 */
export function tmpOutputName(projectId: string, now: number): string {
  return `.sme-render-tmp-${projectId.replace(/[\\/]/g, '_')}-${now}.mp4`;
}

/** プロジェクト共通の Manager。plugin.ts で 1 個だけ生成して使う。 */
export const renderJobs = process.env.SME_RENDER_MOCK === '1'
  ? new RenderJobManager(createMockRenderDeps(
      Number(process.env.SME_RENDER_MOCK_DELAY_MS ?? '3000'),
    ))
  : new RenderJobManager();

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
 * - Remotion render ジョブを開始する。
 * - 同時実行は 1 本のみ（409 で弾く）。
 * - 一時出力は最終出力と同一ディレクトリ（out/）・ドット始まりで置く。
 */
export async function handleRenderPost(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
  force = false,
): Promise<void> {
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
  mkdirSync(outDir, { recursive: true });

  const isMock = process.env.SME_RENDER_MOCK === '1';
  // mock 時は install を走らせない。実行時は node_modules の有無で判定する。
  const needsInstall = isMock ? false : !existsSync(join(projectDir, 'node_modules'));

  const tmpOutput = join(outDir, tmpOutputName(projectId, Date.now()));
  const finalOutput = join(outDir, renderOutputName(options));
  // 仕上げ工程（スーパーサンプリング縮小）。mock 時は ffmpeg を起動しない。
  const postOutput = `${tmpOutput}.final.mp4`;

  // 「カットしただけ」なら Remotion で描き直さず ffmpeg で切って繋ぐ（4K で 10 時間超 → 数分）。
  // 判定・フィルタ生成に失敗した場合は黙って通常経路へ落ちる（書き出せないより遅い方がまし）。
  // 出力先は通常経路と同じ tmpOutput にして、成功後の rename もそのまま共用する。
  const ffmpeg = resolveFfmpegBin();
  const fast = isMock || !ffmpeg.ok ? null : planFastCut(projectDir, options, tmpOutput);

  const job = renderJobs.start(projectId, {
    projectDir,
    // 高速経路は Remotion を使わないので node_modules も要らない。
    needsInstall: fast === null ? needsInstall : false,
    tmpOutput,
    finalOutput,
    extraArgs: renderExtraArgs(options),
    ...(fast === null
      ? (isMock
        ? {}
        : { post: { command: 'ffmpeg', args: postScaleArgs(options, tmpOutput, postOutput, projectResolution(projectDir)), output: postOutput } })
      : {
        fastCut: {
          command: ffmpeg.ok ? ffmpeg.bin : 'ffmpeg',
          args: fast.args,
          totalFrames: fast.totalFrames,
          verify: fast.verify,
        },
      }),
  });

  sendJson(res, 200, { ok: true, startedAt: job.startedAt, fastCut: fast !== null });
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

  const job = renderJobs.get(projectId);
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
      // failed はジョブが保持されたままなので、観測済みとしてここで破棄する
      // （done/cancelled は既に cleanup 済みで no-op）。
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

/** path が root 配下（または root 自身）か。resolvePublicAsset と同じ判定。 */
function isContained(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * out/ 直下の書き出し済み動画（中間ファイルを除く）。新しい順ではなく列挙順。
 *
 * reveal は OS のファイラへパスを渡す＝プロジェクト外を指せてはいけない。
 * out/ 配下に外部を指す symlink が置かれていても実体で弾く
 * （`resolvePublicAsset` と同じ「解決 → realpath の 2 段封じ込め」）。
 */
export function listOutputVideos(outDir: string): Array<{ name: string; path: string; mtimeMs: number }> {
  let entries: string[];
  let realOut: string;
  try {
    realOut = realpathSync(outDir);
    entries = readdirSync(outDir);
  } catch {
    // out/ が無いプロジェクト（未書き出し）は候補ゼロ。
    return [];
  }
  const out: Array<{ name: string; path: string; mtimeMs: number }> = [];
  for (const name of entries) {
    // 中間ファイルは全て '.' 始まり（tmpOutputName ＋ その .final.mp4）。
    if (name.startsWith('.') || !name.toLowerCase().endsWith('.mp4')) continue;
    try {
      const real = realpathSync(join(outDir, name));
      // 実体が out/ の外を指す symlink は候補にしない。
      if (!isContained(real, realOut)) continue;
      out.push({ name, path: real, mtimeMs: statSync(real).mtimeMs });
    } catch {
      // 列挙と解決の間に消えたファイル・壊れた symlink は無視する。
    }
  }
  return out;
}

/**
 * 「フォルダで表示」で開くファイルを決める。
 *
 * ①ジョブが記録した実出力（解像度で名前が変わるため固定名で決め打ちしない）
 * ②記録が無い／消えている場合は out/ の最新 mp4
 *   （**サーバ再起動でジョブ記録が消えた場合や、前回セッションで書き出した成果物**を開くため。
 *    ジョブ record 自体は完了時に cleanup で消えるが、パスは lastOutput が保持するので
 *    「同一プロセス内で書き出した直後」は必ず①で当たる）
 * ③候補なしなら null（呼び出し側が 404）
 *
 * 戻り値の `fallback` は②で決まったことを示す（クライアントが「最新ファイルを開いた」と断れる）。
 */
export function resolveRevealTarget(
  outDir: string,
  recordedPath: string | undefined,
): { path: string; fallback: boolean } | null {
  if (recordedPath !== undefined && recordedPath !== '' && existsSync(recordedPath)) {
    return { path: recordedPath, fallback: false };
  }
  const files = listOutputVideos(outDir);
  if (files.length === 0) return null;
  const newest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  return { path: newest.path, fallback: true };
}

/**
 * POST /api/render/reveal?id=<projectId>
 *
 * 書き出し済み動画を OS のファイラで表示する。無ければ 404。
 *
 * 出力名は `renderOutputName(options)` が解像度で変える（video.mp4 /
 * video-1080p.mp4 / video-720p.mp4）。ここで固定名 out/video.mp4 を見ていたため
 * 720p・1080p で書き出すと常に 404 になっていた（2026-08-08 修正）。
 */
export function handleRenderReveal(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
): void {
  const target = resolveRevealTarget(join(projectDir, 'out'), renderJobs.lastOutput(projectId));
  if (target === null) {
    sendJson(res, 404, { error: 'no-output' });
    return;
  }
  // fire-and-forget: spawn の成否を待たずに 200 を返す。
  revealInFinder(target.path, process.platform);
  // fallback=true は「今回の書き出しそのもの」ではなく out/ の最新を開いたことを示す。
  sendJson(res, 200, { ok: true, fallback: target.fallback });
}

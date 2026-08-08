import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, sendJson } from './http';
import { parseVideoConfig } from '../core/videoConfig';
import { resolveFfmpegBin } from './resolveFfmpeg';
import { previewProxyName } from './previewProxy';
import { buildPreviewProxyArgs } from './buildPreviewProxyArgs';
import {
  analyzeProxyNeed,
  probeDurationSeconds,
  probeProxySource,
  type ProxySourceInfo,
} from './previewProxyAnalysis';
import { PreviewProxyJobManager, createMockPreviewProxyDeps } from './previewProxyJob';
import { heavyJobGate, heavyJobCounts } from './systemLoad';

/** プロジェクト共通の Manager。plugin.ts で 1 個だけ使う。 */
export const previewProxyJobs = process.env.SME_PREVIEW_MOCK === '1'
  ? new PreviewProxyJobManager(createMockPreviewProxyDeps(
      Number(process.env.SME_PREVIEW_MOCK_DELAY_MS ?? '3000'),
    ))
  : new PreviewProxyJobManager();

/** videoConfig.ts から videoFile を取得。失敗時は 'main.mp4'（normalizeApi と同じ割り切り）。 */
function resolveVideoFile(projectDir: string): string {
  try {
    return parseVideoConfig(readFileSync(join(projectDir, 'src', 'videoConfig.ts'), 'utf8')).videoFile;
  } catch {
    return 'main.mp4';
  }
}

/** SME_PREVIEW_MOCK=1 用のダミー元動画情報（mock deps の進捗 60 秒と揃える）。 */
const MOCK_SOURCE: ProxySourceInfo = {
  sizeBytes: 600 * 1024 * 1024,
  durationSeconds: 60,
  width: 1280,
  height: 720,
  fps: 30,
  avgFps: 30,
  codecName: 'h264',
};

/**
 * GET /api/preview-proxy/status?id=<projectId>
 * 軽量版の有無と、無い場合の推奨判定（理由付き）を返す。
 * ffprobe が使えない等の失敗は「推奨なし」へフォールバックし、エディタを止めない。
 */
export function handlePreviewProxyStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
): void {
  const videoFile = resolveVideoFile(projectDir);
  const publicDir = join(projectDir, 'public');
  const hasProxy = existsSync(join(publicDir, previewProxyName(videoFile)));
  const running = previewProxyJobs.exists(projectId);
  if (hasProxy) {
    sendJson(res, 200, { hasProxy: true, recommended: false, reasons: [], running });
    return;
  }
  if (process.env.SME_PREVIEW_MOCK === '1') {
    sendJson(res, 200, { hasProxy: false, recommended: true, reasons: ['長尺（モック）'], running });
    return;
  }
  const videoAbs = join(publicDir, videoFile);
  if (!existsSync(videoAbs)) {
    sendJson(res, 200, { hasProxy: false, recommended: false, reasons: [], running });
    return;
  }
  try {
    const rec = analyzeProxyNeed(probeProxySource(videoAbs));
    sendJson(res, 200, { hasProxy: false, ...rec, running });
  } catch {
    // ffmpeg 未導入・probe 失敗時は推奨を出さない（取り込み自体は別経路で案内済み）
    sendJson(res, 200, { hasProxy: false, recommended: false, reasons: [], running });
  }
}

/** POST /api/preview-proxy?id=<projectId> — 軽量版の生成を開始する。 */
export function handlePreviewProxyPost(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
  force = false,
): void {
  if (previewProxyJobs.exists(projectId)) {
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
  const videoFile = resolveVideoFile(projectDir);
  const publicDir = join(projectDir, 'public');
  const videoAbs = join(publicDir, videoFile);
  if (!existsSync(videoAbs)) {
    throw new HttpError(400, `public/${videoFile} が見つかりません`);
  }

  const isMock = process.env.SME_PREVIEW_MOCK === '1';
  let ffmpegBin = 'ffmpeg';
  let source: ProxySourceInfo;
  if (isMock) {
    source = MOCK_SOURCE;
  } else {
    const r = resolveFfmpegBin();
    if (!r.ok) throw new HttpError(500, r.message);
    ffmpegBin = r.bin;
    source = probeProxySource(videoAbs);
  }

  // 一時出力は一意名（dot 始まり）。Windows で cancel 直後に再開した場合、
  // kill 済み ffmpeg がまだ旧 tmp を掴んでいても新名で衝突しない（normalize と同型）。
  const tmpOutput = join(publicDir, `.sme-preview-tmp-${projectId}-${Date.now()}.mp4`);
  const finalOutput = join(publicDir, previewProxyName(videoFile));

  const job = previewProxyJobs.start(projectId, {
    ffmpeg: ffmpegBin,
    ffmpegArgs: buildPreviewProxyArgs({
      input: videoAbs,
      output: tmpOutput,
      sourceWidth: source.width,
      sourceHeight: source.height,
      fps: source.fps,
      avgFps: source.avgFps,
    }),
    tmpOutput,
    finalOutput,
    durationSeconds: source.durationSeconds,
    probeDuration: isMock ? () => source.durationSeconds : probeDurationSeconds,
  });

  sendJson(res, 200, { ok: true, startedAt: job.startedAt });
}

/** GET /api/preview-proxy?id=<projectId> — SSE 進捗（percent 付き）。 */
/** deprecated: /api/events(?id=) の preview-proxy チャネルへ統合済み。 */
export function handlePreviewProxySse(req: IncomingMessage, res: ServerResponse, projectId: string): void {
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

  const job = previewProxyJobs.get(projectId);
  if (!job) {
    safeWrite({ type: 'idle' });
    safeEnd();
    return;
  }
  safeWrite({ type: 'snapshot', job });
  if (job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled') {
    safeWrite({ type: 'done', phase: job.phase, error: job.error });
    previewProxyJobs.discard(projectId);
    safeEnd();
    return;
  }

  const unsub = previewProxyJobs.subscribe(projectId, (ev) => {
    safeWrite({ type: 'event', event: ev });
    if (ev.phase === 'done' || ev.phase === 'failed' || ev.phase === 'cancelled') {
      safeWrite({ type: 'done', phase: ev.phase, error: ev.error });
      unsub();
      // onSpawnError は cleanup せず job を保持するため、live path でも discard する。
      previewProxyJobs.discard(projectId);
      safeEnd();
    }
  });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
}

/** DELETE /api/preview-proxy?id=<projectId> — 実行中ジョブのキャンセル。 */
export function handlePreviewProxyDelete(_req: IncomingMessage, res: ServerResponse, projectId: string): void {
  if (!previewProxyJobs.cancel(projectId)) {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }
  sendJson(res, 200, { ok: true });
}

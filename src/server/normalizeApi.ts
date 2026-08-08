import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, sendJson } from './http';
import { readBodyText, JOB_BODY_MAX_BYTES } from './readBody';
import { parseVideoConfig } from '../core/videoConfig';
import {
  buildMeasureArgs,
  buildApplyArgs,
  parseLoudnormJson,
  targetToLufs,
  type NormalizeStrength,
} from './buildNormalizeArgs';
import { resolveFfmpegBin } from './resolveFfmpeg';
import {
  ensureBackup,
  resolveInputFromBackup,
  writeNormalizeMarker,
  readNormalizeMarker,
  restoreFromBackup,
  isNormalizeApplied,
  backupName,
} from './normalizeState';
import { NormalizeJobManager, createMockNormalizeDeps } from './normalizeJob';
import { syncPreviewProxyAudio } from './previewProxy';
import { heavyJobGate, heavyJobCounts } from './systemLoad';

/** プロジェクト共通の Manager。plugin.ts で 1 個だけ使う。 */
export const normalizeJobs = process.env.SME_NORMALIZE_MOCK === '1'
  ? new NormalizeJobManager(createMockNormalizeDeps(
      Number(process.env.SME_NORMALIZE_MOCK_DELAY_MS ?? '3000'),
    ))
  : new NormalizeJobManager();

/** videoConfig.ts から videoFile を取得。失敗時は 'main.mp4'。 */
function resolveVideoFile(projectDir: string): string {
  try {
    return parseVideoConfig(readFileSync(join(projectDir, 'src', 'videoConfig.ts'), 'utf8')).videoFile;
  } catch {
    return 'main.mp4';
  }
}

/** POST /api/normalize?id=<projectId> — ボディ { strength?: 'loud'|'standard'|'quiet' } */
export async function handleNormalizePost(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
  force = false,
): Promise<void> {
  const videoFile = resolveVideoFile(projectDir);
  const videoDir = join(projectDir, 'public');
  const videoAbs = join(videoDir, videoFile);
  if (!existsSync(videoAbs)) {
    throw new HttpError(400, `public/${videoFile} が見つかりません`);
  }
  if (normalizeJobs.exists(projectId)) {
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

  let strength: NormalizeStrength = 'standard';
  const text = await readBodyText(req, JOB_BODY_MAX_BYTES);
  if (text.trim()) {
    try {
      const s = (JSON.parse(text) as Record<string, unknown>)['strength'];
      if (s === 'loud' || s === 'standard' || s === 'quiet') strength = s;
    } catch {
      // JSON 解析失敗のみ既定値へフォールバック（過大ボディ 413 は上で拒否済み）
    }
  }

  ensureBackup(videoDir, videoFile);
  const inputPath = resolveInputFromBackup(videoDir, videoFile);
  const tmpOutput = join(videoDir, `.sme-normalize-tmp-${projectId}-${Date.now()}.mp4`);
  const targetLufs = targetToLufs(strength);

  const isMock = process.env.SME_NORMALIZE_MOCK === '1';
  let ffmpegBin = 'ffmpeg';
  if (!isMock) {
    const r = resolveFfmpegBin();
    if (!r.ok) throw new HttpError(500, r.message);
    ffmpegBin = r.bin;
  }

  const job = normalizeJobs.start(projectId, {
    ffmpeg: ffmpegBin,
    measureArgs: buildMeasureArgs({ input: inputPath, targetLufs }),
    parseMeasured: parseLoudnormJson,
    buildApplyArgs: (measured) => buildApplyArgs({ input: inputPath, output: tmpOutput, targetLufs, measured }),
    tmpOutput,
    finalOutput: videoAbs,
  });

  const unsubMarker = normalizeJobs.subscribe(projectId, (ev) => {
    if (ev.phase === 'done') {
      writeNormalizeMarker(projectDir, { applied: true, strength, backupRel: backupName(videoFile) });
      // プレビュー軽量版（main.preview.mp4）の音声も正規化後の本体へ同期し、
      // エディタのプレビューで効果が聞こえるようにする（プロキシが無ければ no-op）。
      if (!isMock) syncPreviewProxyAudio(videoDir, videoFile, ffmpegBin);
      unsubMarker();
    }
  });

  sendJson(res, 200, { ok: true, startedAt: job.startedAt, strength });
}

/** GET /api/normalize?id=<projectId> — SSE 進捗。 */
/** deprecated: /api/events(?id=) の normalize チャネルへ統合済み。 */
export function handleNormalizeSse(_req: IncomingMessage, res: ServerResponse, projectId: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const safeWrite = (data: unknown): void => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
  const safeEnd = (): void => { if (!res.writableEnded) res.end(); };

  const job = normalizeJobs.get(projectId);
  if (!job) { safeWrite({ type: 'idle' }); safeEnd(); return; }
  safeWrite({ type: 'snapshot', job });
  if (job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled') {
    safeWrite({ type: 'done', phase: job.phase, error: job.error });
    normalizeJobs.discard(projectId);
    safeEnd();
    return;
  }

  const unsub = normalizeJobs.subscribe(projectId, (ev) => {
    safeWrite({ type: 'event', event: ev });
    if (ev.phase === 'done' || ev.phase === 'failed' || ev.phase === 'cancelled') {
      safeWrite({ type: 'done', phase: ev.phase, error: ev.error });
      unsub();
      // onSpawnError は cleanup せず job を保持するため、live path でも discard する。
      // done/failed/cancelled で既に cleanup 済みなら discard は安全な no-op。
      normalizeJobs.discard(projectId);
      safeEnd();
    }
  });
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 25_000);
  _req.on('close', () => { clearInterval(heartbeat); unsub(); });
}

/** DELETE /api/normalize?id=<projectId> — 実行中ジョブのキャンセル。 */
export function handleNormalizeDelete(_req: IncomingMessage, res: ServerResponse, projectId: string): void {
  if (!normalizeJobs.cancel(projectId)) { sendJson(res, 404, { error: 'not-found' }); return; }
  sendJson(res, 200, { ok: true });
}

/** POST /api/normalize/restore?id=<projectId> — バックアップから復元。 */
export function handleNormalizeRestore(_req: IncomingMessage, res: ServerResponse, projectId: string, projectDir: string): void {
  if (normalizeJobs.exists(projectId)) { sendJson(res, 409, { error: 'job-running' }); return; }
  const marker = readNormalizeMarker(projectDir);
  if (!marker) { sendJson(res, 404, { error: 'no-backup' }); return; }
  const videoFile = resolveVideoFile(projectDir);
  if (!restoreFromBackup(join(projectDir, 'public'), videoFile)) { sendJson(res, 404, { error: 'no-backup' }); return; }
  writeNormalizeMarker(projectDir, { applied: false, strength: marker.strength, backupRel: marker.backupRel });
  // プレビュー軽量版の音声も、復元後の本体音声へ戻す（プロキシが無ければ no-op）。
  if (process.env.SME_NORMALIZE_MOCK !== '1') {
    const r = resolveFfmpegBin();
    if (r.ok) syncPreviewProxyAudio(join(projectDir, 'public'), videoFile, r.bin);
  }
  sendJson(res, 200, { ok: true, applied: false });
}

/** GET /api/normalize/status?id=<projectId> — 適用状態（クライアントが自前取得）。 */
export function handleNormalizeStatus(_req: IncomingMessage, res: ServerResponse, _projectId: string, projectDir: string): void {
  const marker = readNormalizeMarker(projectDir);
  sendJson(res, 200, { applied: isNormalizeApplied(projectDir), strength: marker?.strength ?? 'standard' });
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError, sendJson } from './http';
import { readBodyText, JOB_BODY_MAX_BYTES } from './readBody';
import { parseVideoConfig } from '../core/videoConfig';
import { buildDenoiseArgs, type DenoiseStrength } from './buildDenoiseArgs';
import { resolveFfmpegBin } from './resolveFfmpeg';
import {
  ensureBackup,
  resolveInputFromBackup,
  writeDenoiseMarker,
  readDenoiseMarker,
  restoreFromBackup,
  backupName,
} from './denoiseState';
import { DenoiseJobManager, createMockDenoiseDeps } from './denoiseJob';
import { heavyJobGate, heavyJobCounts } from './systemLoad';

/** プロジェクト共通の Manager。plugin.ts で 1 個だけ生成して使う。 */
export const denoiseJobs = process.env.SME_DENOISE_MOCK === '1'
  ? new DenoiseJobManager(createMockDenoiseDeps(
      Number(process.env.SME_DENOISE_MOCK_DELAY_MS ?? '3000'),
    ))
  : new DenoiseJobManager();

/** videoConfig.ts のソースから videoFile を取得する。読み込み失敗時は 'main.mp4' を返す。 */
function resolveVideoFile(projectDir: string): string {
  const configPath = join(projectDir, 'src', 'videoConfig.ts');
  try {
    const source = readFileSync(configPath, 'utf8');
    const config = parseVideoConfig(source);
    return config.videoFile;
  } catch {
    return 'main.mp4';
  }
}

/**
 * POST /api/denoise?id=<projectId>
 *
 * ボディ: { strength?: 'weak' | 'mid' | 'strong' }
 * - ノイズ除去ジョブを開始する。
 * - 同時実行は 1 本のみ（409 で弾く）。
 * - 二重処理防止: バックアップが存在すれば常にバックアップを入力とする。
 */
export async function handleDenoisePost(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
  force = false,
): Promise<void> {
  const videoFile = resolveVideoFile(projectDir);
  // 動画の実体は public/ 配下。バックアップ・一時出力・差し替え先も同じ public/ に置く
  // （マーカー denoise.json のみプロジェクト直下）。
  const videoDir = join(projectDir, 'public');
  const videoAbs = join(videoDir, videoFile);
  if (!existsSync(videoAbs)) {
    throw new HttpError(400, `public/${videoFile} が見つかりません`);
  }

  if (denoiseJobs.exists(projectId)) {
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

  // ボディから strength を取り出す（任意・数十バイト）。上限付きで読み、超過(413)は拒否する。
  let strength: DenoiseStrength = 'mid';
  const text = await readBodyText(req, JOB_BODY_MAX_BYTES);
  if (text.trim()) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const s = body['strength'];
      if (s === 'weak' || s === 'mid' || s === 'strong') {
        strength = s;
      }
    } catch {
      // JSON 解析失敗のみ既定値へフォールバック（413 は上で拒否済み）
    }
  }

  // バックアップを初回作成（冪等・public/ 配下）。再実行は常にこのバックアップ（原本）を入力にする。
  ensureBackup(videoDir, videoFile);
  const inputPath = resolveInputFromBackup(videoDir, videoFile);

  // 一時出力は最終出力と同一ディレクトリ（public/）に置く＝同一FSで rename がアトミックになる
  // （os.tmpdir() だと別FSで EXDEV throw しうる）。ドット始まりで素材ライブラリ走査に拾われない。
  const tmpOutput = join(videoDir, `.sme-denoise-tmp-${projectId}-${Date.now()}.mp4`);
  const finalOutput = videoAbs;

  // mock モードでは ffmpeg を起動しないため引数の検証のみ行う
  const isMock = process.env.SME_DENOISE_MOCK === '1';

  let ffmpegBin = 'ffmpeg';
  if (!isMock) {
    const ffmpegResult = resolveFfmpegBin();
    if (!ffmpegResult.ok) {
      throw new HttpError(500, ffmpegResult.message);
    }
    ffmpegBin = ffmpegResult.bin;
  }

  const ffmpegArgs = buildDenoiseArgs({ input: inputPath, output: tmpOutput, strength });

  const job = denoiseJobs.start(projectId, {
    ffmpeg: ffmpegBin,
    ffmpegArgs,
    tmpOutput,
    finalOutput,
  });

  // 完了後のマーカー書き込みをサブスクライブで処理する
  denoiseJobs.subscribe(projectId, (ev) => {
    if (ev.phase === 'done') {
      writeDenoiseMarker(projectDir, {
        applied: true,
        strength,
        backupRel: backupName(videoFile),
      });
    }
  });

  sendJson(res, 200, { ok: true, startedAt: job.startedAt, strength });
}

/** GET /api/denoise?id=<projectId> — SSE で進捗をストリーム。 */
/** deprecated: /api/events(?id=) の denoise チャネルへ統合済み。 */
export function handleDenoiseSse(
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

  const job = denoiseJobs.get(projectId);
  if (!job) {
    safeWrite({ type: 'idle' });
    safeEnd();
    return;
  }
  safeWrite({ type: 'snapshot', job });

  if (job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled') {
    safeWrite({ type: 'done', phase: job.phase, error: job.error });
    denoiseJobs.discard(projectId);
    safeEnd();
    return;
  }

  const unsub = denoiseJobs.subscribe(projectId, (ev) => {
    safeWrite({ type: 'event', event: ev });
    if (ev.phase === 'done' || ev.phase === 'failed' || ev.phase === 'cancelled') {
      safeWrite({ type: 'done', phase: ev.phase, error: ev.error });
      unsub();
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

/** DELETE /api/denoise?id=<projectId> — 実行中のジョブをキャンセル（破棄）。 */
export function handleDenoiseDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): void {
  const ok = denoiseJobs.cancel(projectId);
  if (!ok) {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * POST /api/denoise/restore?id=<projectId>
 *
 * バックアップから原本動画を復元し、ノイズ除去を取り消す。
 */
export function handleDenoiseRestore(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
): void {
  if (denoiseJobs.exists(projectId)) {
    sendJson(res, 409, { error: 'job-running' });
    return;
  }
  const videoFile = resolveVideoFile(projectDir);
  const marker = readDenoiseMarker(projectDir);
  if (!marker) {
    sendJson(res, 404, { error: 'no-backup' });
    return;
  }
  // ファイルは public/ から復元し、マーカーはプロジェクト直下で applied=false に更新する。
  const restored = restoreFromBackup(join(projectDir, 'public'), videoFile);
  if (!restored) {
    sendJson(res, 404, { error: 'no-backup' });
    return;
  }
  writeDenoiseMarker(projectDir, { applied: false, strength: marker.strength, backupRel: marker.backupRel });
  sendJson(res, 200, { ok: true, applied: false });
}

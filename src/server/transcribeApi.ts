import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HttpError, sendJson } from './http';
import { TranscribeJobManager } from './transcribeJob';
import { writeTimestampedBackup } from './transcribeBackup';
import { heavyJobGate, heavyJobCounts } from './systemLoad';

/** プロジェクト共通の Manager。plugin.ts で 1 個だけ生成して使う。 */
export const transcribeJobs = new TranscribeJobManager();

/** scripts/transcribe.py の絶対パス。 */
function scriptPath(): string {
  // src/server/ から見て 2 階層上 + scripts/transcribe.py
  return resolve(import.meta.dirname, '..', '..', 'scripts', 'transcribe.py');
}

/** GET /api/transcribe?id=<projectId> — SSE で進捗をストリーム。 */
/** deprecated: /api/events(?id=) の transcribe チャネルへ統合済み。 */
export function handleTranscribeSse(
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

  // 初回イベント: 現在の job 状態 or 'idle'
  const job = transcribeJobs.get(projectId);
  if (!job) {
    safeWrite({ type: 'idle' });
    safeEnd();
    return;
  }
  safeWrite({ type: 'snapshot', job });

  // 接続時点で既に終了状態のジョブ（spawn 失敗で即 failed 等）は、購読しても
  // 以後イベントが来ないので done を出せない。ここで done を出して観測済みにし、
  // 保持されていたジョブを破棄する（バナーが固まるのを防ぐ）。
  if (job.phase === 'completed' || job.phase === 'failed' || job.phase === 'cancelled') {
    safeWrite({ type: 'done', phase: job.phase, error: job.error });
    transcribeJobs.discard(projectId);
    safeEnd();
    return;
  }

  // live updates
  const unsub = transcribeJobs.subscribe(projectId, (ev) => {
    safeWrite({ type: 'event', event: ev });
    if (ev.phase === 'completed' || ev.phase === 'failed' || ev.phase === 'cancelled') {
      safeWrite({ type: 'done', phase: ev.phase, error: ev.error });
      unsub();
      safeEnd();
    }
  });

  // 25 秒 heartbeat
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
}

/** DELETE /api/transcribe?id=<projectId> — 実行中のジョブをキャンセル。 */
export function handleTranscribeDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): void {
  const ok = transcribeJobs.cancel(projectId);
  if (!ok) {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/** POST /api/transcribe?id=<projectId> */
export function handleTranscribePost(
  _req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  projectDir: string,
  force = false,
): void {
  const video = join(projectDir, 'public', 'main.mp4');
  if (!existsSync(video)) {
    throw new HttpError(400, 'public/main.mp4 が見つかりません');
  }
  if (transcribeJobs.exists(projectId)) {
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
  const out = join(projectDir, 'transcript.json');
  const paramsPath = join(projectDir, 'transcribe_params.json');
  const backupPath = writeTimestampedBackup(projectDir, 'transcript.json');
  const args = ['--video', video, '--out', out];
  if (existsSync(paramsPath)) args.push('--params', paramsPath);
  const mock = process.env.SME_TRANSCRIBE_MOCK === '1';
  if (mock) args.unshift('--mock-backend');
  const job = transcribeJobs.start(projectId, {
    backupPath,
    spawnOpts: { scriptPath: scriptPath(), args, cwd: projectDir },
  });
  sendJson(res, 200, { ok: true, startedAt: job.startedAt, backupPath });
}

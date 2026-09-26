// src/server/jobRegistries.ts
/**
 * プロジェクト単位で走る「重いジョブ」の登録簿を 1 箇所へ集約する（再レビュー M-4）。
 *
 * この 5 種は 2 箇所で列挙されていた:
 *   ① `DELETE /api/project` の busy 判定（`findBusyJobs` へ渡す登録簿）
 *   ② サーバ停止時の `killAll()`（進行中 subprocess の後始末）
 * 別々に手で並べていると、ジョブ種別を足したときに片方だけ結線されて
 * 「書き出し中なのに削除できてしまう」/「停止しても ffmpeg が残る」といった
 * 結線漏れが静かに入る（型もテストも気づけない）。導出元をこの定数 1 つにして
 * 構造的に防ぐ。
 */
import { transcribeJobs } from './transcribeApi';
import { denoiseJobs } from './denoiseApi';
import { normalizeJobs } from './normalizeApi';
import { renderJobs } from './renderApi';
import { previewProxyJobs } from './previewProxyApi';
import type { JobLookup } from './projectBusy';
import { sequenceTranscriptions } from './sequence/transcriptions';
import { sequenceExports } from './sequence/exports';

/** busy 照会（get）と後始末（killAll）の両方に使える、プロジェクト単位のジョブ登録簿。 */
export interface ProjectJobManager extends JobLookup {
  killAll(): void;
}

/**
 * 正本。ここへ 1 行足せば busy 判定と killAll の両方へ同時に反映される。
 * キーは busy 応答の `jobs` に載る種別名（クライアントの文言に出る）。
 */
export const PROJECT_JOB_MANAGERS: Record<string, ProjectJobManager> = {
  render: renderJobs,
  transcribe: transcribeJobs,
  nativeTranscribe: sequenceTranscriptions,
  nativeRender: sequenceExports,
  denoise: denoiseJobs,
  normalize: normalizeJobs,
  previewProxy: previewProxyJobs,
};

/** 進行中の subprocess を全て kill する（サーバ停止時）。 */
export function killAllProjectJobs(): void {
  for (const manager of Object.values(PROJECT_JOB_MANAGERS)) manager.killAll();
}

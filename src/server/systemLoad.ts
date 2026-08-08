// src/server/systemLoad.ts — 重ジョブ（render/transcribe/denoise/normalize/preview-proxy）
// 開始 API 冒頭のサーバ側負荷ゲート。環境（CPU コア数・メモリ）から推奨同時実行数を
// 算出し、実行中の重ジョブ数がそれ以上なら confirmationRequired を返す（force で貫通可）。
import { cpus, totalmem } from 'node:os';
import { renderJobs } from './renderApi';
import { transcribeJobs } from './transcribeApi';
import { denoiseJobs } from './denoiseApi';
import { normalizeJobs } from './normalizeApi';
import { previewProxyJobs } from './previewProxyApi';

/**
 * 環境（CPU コア数・メモリ）から推奨される重ジョブの最大同時実行数を算出する。
 * `max(1, min(floor(cores/4), floor(memGB/10)))`。
 * envOverride（SME_MAX_HEAVY_JOBS）が正の整数ならそれを優先する。
 */
export function recommendedMaxHeavyJobs(cores: number, memBytes: number, envOverride?: string): number {
  if (envOverride !== undefined) {
    const parsed = Number.parseInt(envOverride, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const memGB = memBytes / 1024 ** 3;
  return Math.max(1, Math.min(Math.floor(cores / 4), Math.floor(memGB / 10)));
}

export interface HeavyJobGateDeps {
  /** 実行中の重ジョブ数を返すクロージャの束（合計が running になる）。 */
  counts: Array<() => number>;
  /** テスト用の CPU コア数注入（省略時は os.cpus().length）。 */
  cores?: number;
  /** テスト用のメモリ量注入（省略時は os.totalmem()）。 */
  memBytes?: number;
}

export type HeavyJobGateResult =
  | { allowed: true }
  | { allowed: false; running: number; recommendedMax: number };

/**
 * 重ジョブ開始 API 冒頭のゲート。
 * force=true は常に allowed:true（貫通）。
 * それ以外は running(counts の合計) が recommendedMax 未満なら allowed:true、
 * 以上なら allowed:false + running/recommendedMax を返す（呼び出し側が 409 に変換する）。
 */
export function heavyJobGate(force: boolean, deps: HeavyJobGateDeps): HeavyJobGateResult {
  if (force) {
    return { allowed: true };
  }
  const running = deps.counts.reduce((sum, count) => sum + count(), 0);
  const cores = deps.cores ?? cpus().length;
  const memBytes = deps.memBytes ?? totalmem();
  const recommendedMax = recommendedMaxHeavyJobs(cores, memBytes, process.env.SME_MAX_HEAVY_JOBS);
  if (running < recommendedMax) {
    return { allowed: true };
  }
  return { allowed: false, running, recommendedMax };
}

/** 5 マネージャ（render/transcribe/denoise/normalize/preview-proxy）の activeCount を束ねる。 */
export function heavyJobCounts(): Array<() => number> {
  return [
    () => renderJobs.activeCount(),
    () => transcribeJobs.activeCount(),
    () => denoiseJobs.activeCount(),
    () => normalizeJobs.activeCount(),
    () => previewProxyJobs.activeCount(),
  ];
}

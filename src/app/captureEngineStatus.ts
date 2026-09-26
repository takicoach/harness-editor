// src/app/captureEngineStatus.ts
/**
 * GET /api/capture-engine/status の応答を UI 用に検査して取り込む（M2d T2 修正 M-1）。
 *
 * 形が違う応答（プロキシの HTML エラーページ・古いサーバ・型崩れ）を
 * 「ok:false ＝ 撮影エンジン未導入」と誤読すると、正常な環境で「未導入」案内を出してしまう。
 * ok が boolean でなければ**未取得（null）**として扱い、従来表示のままにする。
 */
import { asFastCutIneligibleReason, type FastCutIneligibleReason } from '../shared/captureOverlays';

export interface CaptureEngineStatus {
  ok: boolean;
  /** 不在理由（復旧案内の出し分け用）。未知の値は落とす。 */
  kind?: FastCutIneligibleReason;
  /** サーバからの受講生向けメッセージ。 */
  message?: string;
  /** 解決経路（診断用・UI では使わない）。 */
  source?: string;
}

/** 応答 JSON を検査して取り込む。取り込めなければ null（＝未取得扱い）。 */
export function parseCaptureEngineStatus(value: unknown): CaptureEngineStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['ok'] !== 'boolean') return null;
  const kind = asFastCutIneligibleReason(raw['kind']);
  const message = typeof raw['message'] === 'string' ? raw['message'] : undefined;
  const source = typeof raw['source'] === 'string' ? raw['source'] : undefined;
  return {
    ok: raw['ok'],
    ...(kind === undefined ? {} : { kind }),
    ...(message === undefined ? {} : { message }),
    ...(source === undefined ? {} : { source }),
  };
}

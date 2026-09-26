import { resolveChromiumBin, type ResolveChromiumResult, type ResolveChromiumFailKind } from './resolveChromium';

/**
 * GET /api/capture-engine/status（M2d T2・設計判断5）。
 *
 * 撮影エンジン（chrome-headless-shell）実体の**存在検査のみ**を行い、resolveChromiumBin() の
 * 結果をそのまま返す。ここでは起動しない（health check は setup 末尾の
 * scripts/chromium-health.ts が担う・設計判断6）。
 *
 * M-3: health スクリプトの拡張子は `.ts`（計画書の `.mjs` は旧案）。resolveChromium を
 * 直接 import して実体解決の正本を共有するため TypeScript のまま置き、`node --import tsx` で
 * 実行する（`.mjs` にすると解決規約を JS 側へ書き写すことになり、正本が二重化する）。
 */
export interface CaptureEngineStatusBody {
  ok: boolean;
  /** 不在理由（ok:false のときだけ）。UI の復旧案内の出し分けに使う。 */
  kind?: ResolveChromiumFailKind;
  /**
   * 受講生向けメッセージ（ok:false のときだけ）。message はユーザー指定値
   * （環境変数 HARNESS_CHROMIUM のパス）のみを echo する（M2d T2 修正2 M-5）。
   */
  message?: string;
  /** 解決経路（ok:true のときだけ・診断用）。 */
  source?: 'env' | 'tools' | 'playwright-cache';
}

export function handleCaptureEngineStatus(
  deps: { resolveChromium?: () => ResolveChromiumResult } = {},
): CaptureEngineStatusBody {
  const result = (deps.resolveChromium ?? resolveChromiumBin)();
  // M-2: 実行ファイルの絶対パス（bin）は返さない。UI は使わず、ローカル API とはいえ
  // 環境のディレクトリ構成を無用に晒さないため（返すのは ok / kind / message / source だけ）。
  return result.ok
    ? { ok: true, source: result.source }
    : { ok: false, kind: result.kind, message: result.message };
}

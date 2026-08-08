import { evalDataModule } from './dataModule';
import { clampMainSpeed, DEFAULT_MAIN_SPEED, hasPerSegmentSpeed } from './speedEngine';

export interface SpeedData {
  mainSpeed: number;
  /** 区間 id → 倍率（個別指定のみ）。 */
  segmentSpeeds: Record<number, number>;
}

function parseSegmentSpeeds(v: unknown): Record<number, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<number, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const id = Number(k);
    if (Number.isInteger(id) && typeof val === 'number' && Number.isFinite(val)) {
      out[id] = clampMainSpeed(val);
    }
  }
  return out;
}

/**
 * `speedData.ts`（`MAIN_SPEED` ＋ 任意 `SEGMENT_SPEEDS`）の parse。
 * 不在 / 不正 / 1.0 は「速度なし」（mainSpeed=1・空マップ）として扱う（後方互換）。
 */
export function parseSpeedData(source: string | null): SpeedData {
  if (source === null) return { mainSpeed: DEFAULT_MAIN_SPEED, segmentSpeeds: {} };
  let m: Record<string, unknown>;
  try {
    m = evalDataModule(source, {});
  } catch {
    return { mainSpeed: DEFAULT_MAIN_SPEED, segmentSpeeds: {} };
  }
  const v = m.MAIN_SPEED;
  const mainSpeed =
    typeof v === 'number' && Number.isFinite(v) ? clampMainSpeed(v) : DEFAULT_MAIN_SPEED;
  return { mainSpeed, segmentSpeeds: parseSegmentSpeeds(m.SEGMENT_SPEEDS) };
}

function formatSegmentSpeeds(segmentSpeeds: Record<number, number>): string {
  const entries = Object.keys(segmentSpeeds)
    .map(Number)
    .sort((a, b) => a - b)
    .map((id) => `${id}: ${clampMainSpeed(segmentSpeeds[id] ?? DEFAULT_MAIN_SPEED)}`);
  return `{ ${entries.join(', ')} }`;
}

/**
 * `speedData.ts` ソースを生成。
 * mainSpeed=1 かつ個別指定ゼロ（または冗長のみ）なら null（ファイル不要・後方互換）。
 * 個別指定があれば MAIN_SPEED=1 でも両方出力する。
 */
export function serializeSpeedData(
  mainSpeed: number,
  segmentSpeeds: Record<number, number> = {},
): string | null {
  const r = clampMainSpeed(mainSpeed);
  const perSeg = hasPerSegmentSpeed(segmentSpeeds, r);
  if (r === DEFAULT_MAIN_SPEED && !perSeg) return null;
  const head = `// Harness Editor が生成・更新します（メイン動画の速度）\n\nexport const MAIN_SPEED = ${r};\n`;
  // 冗長（mainSpeed と一致）エントリは落とす。perSeg=false なら空マップ。
  const effective: Record<number, number> = {};
  for (const [k, val] of Object.entries(segmentSpeeds)) {
    if (clampMainSpeed(val) !== r) effective[Number(k)] = clampMainSpeed(val);
  }
  return `${head}export const SEGMENT_SPEEDS: Record<number, number> = ${formatSegmentSpeeds(effective)};\n`;
}

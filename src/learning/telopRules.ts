/** テロップ差分フィードバック（承認済みテロップ修正/追加/削除）の構造。 */
export interface TelopFeedbackEntry {
  videoId: string;
  timestamp: string;
  kind: 'changed' | 'added' | 'removed';
  /** removed/changed で有効。added は ''。 */
  before: string;
  /** added/changed で有効。removed は ''。 */
  after: string;
}

/** 集計済みテロップルール（before→after のテキスト置換）。 */
export interface TelopRule {
  before: string;
  after: string;
}

/** テロップルール集合と観測メタデータ（永続化対象）。 */
export interface TelopRulesFile {
  schemaVersion: 1;
  rules: TelopRule[];
  /** 同一 before に複数の after が競合したときの before 一覧。 */
  conflicts: string[];
  meta: {
    /** before -> after -> 観測した videoId 一覧。 */
    observations: Record<string, Record<string, string[]>>;
    /** before -> 最後に観測した videoId。 */
    lastSeen: Record<string, string>;
  };
}

/** ルール昇格に必要な観測回数（distinct videoId 基準）。閾値は cutRules と同じ 2 だが、
 * conflict 条件は cut/se（added/removed 両観測で即 conflict）と異なり、
 * 同一 before に複数の after がそれぞれ閾値へ同時到達した場合のみ conflict とする（多数決的）。 */
export const TELOP_RULE_PROMOTION_THRESHOLD = 2;

/** 空のテロップルール集合を返す。 */
export function emptyTelopRules(): TelopRulesFile {
  return {
    schemaVersion: 1,
    rules: [],
    conflicts: [],
    meta: { observations: {}, lastSeen: {} },
  };
}

/** 読み込んだ `TelopRulesFile` の observations を防御的に正規化する（破損データでもクラッシュしない）。 */
export function normalizeTelopRulesFile(file: TelopRulesFile): TelopRulesFile {
  const observations: Record<string, Record<string, string[]>> = {};
  for (const [before, variants] of Object.entries(file.meta.observations ?? {})) {
    observations[before] = {};
    for (const [after, videos] of Object.entries(variants ?? {})) {
      observations[before]![after] = Array.isArray(videos) ? [...videos] : [];
    }
  }
  return { ...file, meta: { observations, lastSeen: { ...(file.meta.lastSeen ?? {}) } } };
}

/**
 * 承認済み feedback を観測メタへ加算し、閾値と競合条件からルール集合を再計算する（非破壊）。
 * `changed`（before/after とも非空）のみをルール昇格の対象とする。`added`/`removed` は
 * before→after の対応がないためルール化しない（jsonl への記録のみ・将来の蒸留分析用）。
 * 同一 videoId から同一 before×after の観測が複数回来ても distinct videoId 単位でしかカウントしない
 * （cutRules.applyCutFeedback の I-1 対策と同型）。
 */
export function applyTelopFeedback(prev: TelopRulesFile, entries: TelopFeedbackEntry[]): TelopRulesFile {
  const observations: Record<string, Record<string, string[]>> = {};
  for (const [before, variants] of Object.entries(prev.meta.observations)) {
    observations[before] = {};
    for (const [after, videos] of Object.entries(variants)) {
      observations[before]![after] = [...videos];
    }
  }
  const lastSeen = { ...prev.meta.lastSeen };

  for (const e of entries) {
    if (e.kind !== 'changed') continue;
    const before = e.before.trim();
    const after = e.after.trim();
    if (before === '' || after === '') continue;
    const variants = (observations[before] ??= {});
    const videos = (variants[after] ??= []);
    if (!videos.includes(e.videoId)) videos.push(e.videoId);
    lastSeen[before] = e.videoId;
  }

  const rules: TelopRule[] = [];
  const conflicts: string[] = [];

  for (const [before, variants] of Object.entries(observations).sort(([a], [b]) => a.localeCompare(b, 'ja'))) {
    const promoted = Object.entries(variants).filter(([, videos]) => videos.length >= TELOP_RULE_PROMOTION_THRESHOLD);
    if (promoted.length > 1) {
      conflicts.push(before);
    } else if (promoted.length === 1) {
      rules.push({ before, after: promoted[0]![0] });
    }
  }

  return {
    schemaVersion: 1,
    rules,
    conflicts,
    meta: { observations, lastSeen },
  };
}

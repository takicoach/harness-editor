/** SE 差分フィードバック（承認済み SE 追加/削除）の構造。 */
export interface SeFeedbackEntry {
  videoId: string;
  timestamp: string;
  kind: 'added' | 'removed';
  seFile: string;
  /** 近傍テロップテキスト（cutRules の text に相当する文脈キー）。 */
  contextText: string;
}

/** 集計済み SE ルール。 */
export interface SeRule {
  seFile: string;
  contextText: string;
  action: 'add' | 'remove';
}

/** 1(seFile,contextText)ぶんの観測メタ。distinct videoId 基準で加算する。 */
export interface SeObservation {
  added: number;
  removed: number;
  addedVideos: string[];
  removedVideos: string[];
}

/** SE ルール集合と観測メタデータ（永続化対象）。cutRules.ts の CutRulesFile と同型。 */
export interface SeRulesFile {
  schemaVersion: 1;
  rules: SeRule[];
  conflicts: string[];
  meta: {
    observations: Record<string, SeObservation>;
    lastSeen: Record<string, string>;
  };
}

/** ルール昇格に必要な観測回数（distinct videoId 基準）。cutRules と同じ閾値。 */
export const SE_RULE_PROMOTION_THRESHOLD = 2;

/** (seFile, contextText) を観測メタのキーへ。 */
function observationKey(seFile: string, contextText: string): string {
  return `${seFile}::${contextText}`;
}

/** 空の SE ルール集合を返す。 */
export function emptySeRules(): SeRulesFile {
  return {
    schemaVersion: 1,
    rules: [],
    conflicts: [],
    meta: { observations: {}, lastSeen: {} },
  };
}

/** 読み込んだ `SeRulesFile` の observations を防御的に正規化する（破損データでもクラッシュしない）。 */
export function normalizeSeRulesFile(file: SeRulesFile): SeRulesFile {
  const observations: Record<string, SeObservation> = Object.fromEntries(
    Object.entries(file.meta.observations ?? {}).map(([key, obs]) => [
      key,
      {
        added: obs.added,
        removed: obs.removed,
        addedVideos: obs.addedVideos ?? [],
        removedVideos: obs.removedVideos ?? [],
      },
    ]),
  );
  return { ...file, meta: { ...file.meta, observations } };
}

/**
 * 承認済み feedback を観測メタへ加算し、閾値と競合条件からルール集合を再計算する（非破壊）。
 * cutRules.applyCutFeedback と同じ形（added/removed の二値・distinct videoId 基準・
 * 両方が観測された組は競合として保留）。キーは (seFile, contextText)。
 */
export function applySeFeedback(prev: SeRulesFile, entries: SeFeedbackEntry[]): SeRulesFile {
  const observations: Record<string, SeObservation> = Object.fromEntries(
    Object.entries(prev.meta.observations).map(([k, v]) => [
      k,
      { added: v.added, removed: v.removed, addedVideos: [...v.addedVideos], removedVideos: [...v.removedVideos] },
    ]),
  );
  const lastSeen = { ...prev.meta.lastSeen };
  const keyMeta = new Map<string, { seFile: string; contextText: string }>();
  for (const [key, obs] of Object.entries(prev.meta.observations)) {
    void obs;
    const sep = key.indexOf('::');
    if (sep >= 0) keyMeta.set(key, { seFile: key.slice(0, sep), contextText: key.slice(sep + 2) });
  }

  for (const e of entries) {
    const key = observationKey(e.seFile, e.contextText);
    keyMeta.set(key, { seFile: e.seFile, contextText: e.contextText });
    const obs = (observations[key] ??= { added: 0, removed: 0, addedVideos: [], removedVideos: [] });
    if (e.kind === 'added') {
      if (!obs.addedVideos.includes(e.videoId)) {
        obs.added += 1;
        obs.addedVideos.push(e.videoId);
      }
    } else {
      if (!obs.removedVideos.includes(e.videoId)) {
        obs.removed += 1;
        obs.removedVideos.push(e.videoId);
      }
    }
    lastSeen[key] = e.videoId;
  }

  const rules: SeRule[] = [];
  const conflicts: string[] = [];

  for (const [key, obs] of Object.entries(observations).sort(([a], [b]) => a.localeCompare(b, 'ja'))) {
    if (obs.added > 0 && obs.removed > 0) {
      conflicts.push(key);
      continue;
    }
    const meta = keyMeta.get(key);
    if (!meta) continue;
    if (obs.added >= SE_RULE_PROMOTION_THRESHOLD) {
      rules.push({ seFile: meta.seFile, contextText: meta.contextText, action: 'add' });
    } else if (obs.removed >= SE_RULE_PROMOTION_THRESHOLD) {
      rules.push({ seFile: meta.seFile, contextText: meta.contextText, action: 'remove' });
    }
  }

  return {
    schemaVersion: 1,
    rules,
    conflicts,
    meta: { observations, lastSeen },
  };
}

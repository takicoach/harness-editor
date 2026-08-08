/**
 * カット差分フィードバック（承認済みカット/復元アクション）の構造。
 */
export interface CutFeedbackEntry {
  videoId: string;
  timestamp: string;
  kind: 'added-cut' | 'restored-cut';
  startFrame: number;
  endFrame: number;
  text: string;
}

/**
 * 集計済みカットルール。
 */
export interface CutRule {
  text: string;
  action: 'cut' | 'keep';
}

/** 1テキストぶんの観測メタ。distinct videoId 基準で加算するため観測済み videoId 一覧を保持する。 */
export interface CutObservation {
  added: number;
  restored: number;
  addedVideos: string[];
  restoredVideos: string[];
}

/**
 * カットルール集合と観測メタデータ（永続化対象）。
 */
export interface CutRulesFile {
  schemaVersion: 1;
  rules: CutRule[];
  conflicts: string[];
  meta: {
    observations: Record<string, CutObservation>;
    lastSeen: Record<string, string>;
  };
}

/** ルール昇格に必要な観測回数（distinct videoId 基準）。 */
export const CUT_RULE_PROMOTION_THRESHOLD = 2;

/**
 * 空のカットルール集合を返す。
 */
export function emptyCutRules(): CutRulesFile {
  return {
    schemaVersion: 1,
    rules: [],
    conflicts: [],
    meta: { observations: {}, lastSeen: {} },
  };
}

/**
 * 読み込んだ `CutRulesFile` の observations を防御的に正規化する。
 * `addedVideos`/`restoredVideos` が欠けた旧形式・破損データでも空配列で補い、
 * 呼び出し側がクラッシュしないようにする。
 */
export function normalizeCutRulesFile(file: CutRulesFile): CutRulesFile {
  const observations: Record<string, CutObservation> = Object.fromEntries(
    Object.entries(file.meta.observations).map(([text, obs]) => [
      text,
      {
        added: obs.added,
        restored: obs.restored,
        addedVideos: obs.addedVideos ?? [],
        restoredVideos: obs.restoredVideos ?? [],
      },
    ]),
  );
  return { ...file, meta: { ...file.meta, observations } };
}

/**
 * 承認済み feedback を観測メタへ加算し、閾値と競合条件からルール集合を再計算する（非破壊）。
 * 同一 videoId から同一テキスト×kind の観測が複数回来ても distinct videoId 単位でしか
 * カウントしない（同一動画の再書き出し・再承認による観測回数の二重計上を防止 = I-1）。
 */
export function applyCutFeedback(prev: CutRulesFile, entries: CutFeedbackEntry[]): CutRulesFile {
  const observations: Record<string, CutObservation> = Object.fromEntries(
    Object.entries(prev.meta.observations).map(([k, v]) => [
      k,
      {
        added: v.added,
        restored: v.restored,
        addedVideos: [...v.addedVideos],
        restoredVideos: [...v.restoredVideos],
      },
    ]),
  );
  const lastSeen = { ...prev.meta.lastSeen };

  for (const e of entries) {
    const text = e.text.trim();
    if (text === '') continue;
    const obs = (observations[text] ??= { added: 0, restored: 0, addedVideos: [], restoredVideos: [] });
    if (e.kind === 'added-cut') {
      if (!obs.addedVideos.includes(e.videoId)) {
        obs.added += 1;
        obs.addedVideos.push(e.videoId);
      }
    } else {
      if (!obs.restoredVideos.includes(e.videoId)) {
        obs.restored += 1;
        obs.restoredVideos.push(e.videoId);
      }
    }
    lastSeen[text] = e.videoId;
  }

  const rules: CutRule[] = [];
  const conflicts: string[] = [];

  for (const [text, obs] of Object.entries(observations).sort(([a], [b]) => a.localeCompare(b, 'ja'))) {
    if (obs.added > 0 && obs.restored > 0) {
      conflicts.push(text);
      continue;
    }
    if (obs.added >= CUT_RULE_PROMOTION_THRESHOLD) {
      rules.push({ text, action: 'cut' });
    } else if (obs.restored >= CUT_RULE_PROMOTION_THRESHOLD) {
      rules.push({ text, action: 'keep' });
    }
  }

  return {
    schemaVersion: 1,
    rules,
    conflicts,
    meta: { observations, lastSeen },
  };
}

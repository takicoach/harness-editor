import type { ProjectSummary } from '../shared/types';

/**
 * SSE のライブ差分が触りうるフィールド（＝一覧の全置換と取り合いになる範囲）。
 * `useProjectsWatch` の ProjectStatusPatch と対応する（片方だけ足すと巻き戻りが復活する）。
 */
const LIVE_STATUS_FIELDS = [
  'status',
  'stageManual',
  'activityLabel',
  'activityStartedAt',
  'activityStale',
  'lastEditedAt',
  'steps',
] as const;

/**
 * クライアントが持つ一覧の 1 行。サーバの要約に「構造フィールド（名前・尺・サイズ等）が
 * どの観測から来たか」＝ `snapshotSeq` を足したもの。
 * `statusSeq` の方は「ステータス系フィールドがどの観測から来たか」で、SSE の差分で先に進む。
 * 2 つに分ける理由: ライブ差分はステータス系しか運ばないため、差分を重ねた行の
 * 構造フィールドは差分より古い一覧のままであり、1 つの番号では両者を表せない。
 */
export interface ProjectListEntry extends ProjectSummary {
  /** 構造フィールドの出どころの観測シーケンス（番号を知らないサーバでは 0）。 */
  snapshotSeq: number;
}

/** ライブ差分が触る範囲だけを取り出す（値が undefined のキーも落とさない: 消去の意味を持つため）。 */
function pickLive(p: ProjectSummary): Partial<ProjectSummary> {
  const out: Partial<ProjectSummary> = {};
  for (const key of LIVE_STATUS_FIELDS) {
    (out as Record<string, unknown>)[key] = p[key];
  }
  return out;
}

/**
 * 届いた一覧スナップショットを、今持っている一覧へ**観測の新旧という事実で**取り込む（純関数）。
 *
 * `/api/projects` の応答は「サーバがディスクを読んだ時点」の観測、SSE のライブ差分も同じく観測。
 * どちらが新しいかは**到着順では決まらない**（応答待ちの間にライブ差分が届けば、遅れて着地した
 * 一覧の方が古い）。到着順を信じると、サイドバーの「作業中」が着地の瞬間に巻き戻り、
 * ディスクは変わらないので次のイベントも来ず、次の再取得まで戻らない。
 * そこでサーバが観測ごとに振る単調増加の番号（`statusSeq`）で新旧を決める。
 *
 * - 一覧の方が新しい観測 → そのまま採る。
 * - 手元のライブ差分の方が新しい → ステータス系フィールドだけ手元を残す（巻き戻さない）。
 * - 一覧が構造フィールドの出どころより古い観測 → 構造フィールドも手元を残す
 *   （一覧の応答同士が入れ替わって着地した場合）。
 * - 番号を知らないサーバ（`statusSeq` 無し）→ 従来どおり全置換（ライブ更新が止まるより軽い）。
 */
export function mergeProjectSummaries(
  prev: ReadonlyArray<ProjectListEntry>,
  next: ReadonlyArray<ProjectSummary>,
): ProjectListEntry[] {
  const byId = new Map(prev.map((p) => [p.id, p]));
  return next.map((n) => {
    const p = byId.get(n.id);
    const nSeq = n.statusSeq;
    if (p === undefined || nSeq === undefined) return { ...n, snapshotSeq: nSeq ?? 0 };
    const structural: ProjectListEntry =
      nSeq >= p.snapshotSeq ? { ...n, snapshotSeq: nSeq } : { ...p };
    const pSeq = p.statusSeq ?? 0;
    return nSeq > pSeq
      ? { ...structural, ...pickLive(n), statusSeq: nSeq }
      : { ...structural, ...pickLive(p), statusSeq: pSeq };
  });
}

/**
 * 一覧の 1 行へライブ差分を重ねる（純関数）。一覧に居ない id の差分は捨てる。
 * 差分に観測シーケンスがあり、その行が既にそれ以上の観測を反映していれば**重ねない**
 * （遅れて届いた古い差分が、新しい一覧を巻き戻すのを防ぐ = 逆向きの out-of-order）。
 * 番号の無い差分（ホームのバッジ操作などクライアント側の楽観更新）は常に重ねる。
 */
export function applyStatusPatch(
  list: ReadonlyArray<ProjectListEntry>,
  id: string,
  patch: Partial<ProjectSummary>,
): ProjectListEntry[] {
  return list.map((p) => {
    if (p.id !== id) return p;
    const patchSeq = patch.statusSeq;
    if (patchSeq !== undefined && p.statusSeq !== undefined && patchSeq <= p.statusSeq) return p;
    return { ...p, ...patch, statusSeq: patchSeq ?? p.statusSeq };
  });
}

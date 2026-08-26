import { deleteProjectRequest } from './trashApi';

/** 一括ゴミ箱移動でスキップした 1 件。 */
export interface BulkSkip {
  id: string;
  name: string;
  reason: string;
}

export interface BulkTrashResult {
  /** ゴミ箱へ移動できた id（実行順）。 */
  moved: string[];
  /** 失敗して飛ばした項目（理由つき）。 */
  skipped: BulkSkip[];
}

/**
 * 選択したプロジェクトを**逐次**ゴミ箱へ移動する。並列にしない —
 * DELETE /api/project は実行中ジョブがあると 409（busy）を返し、サーバ側は
 * rename と manifest 更新を伴うため、同時に投げると失敗の切り分けが効かなくなる。
 * 途中の失敗は例外にせず skipped に積んで続行する（1 件のせいで残りが消えない）。
 */
export async function moveProjectsToTrash(
  targets: ReadonlyArray<{ id: string; name: string }>,
  request: (id: string) => Promise<unknown> = deleteProjectRequest,
): Promise<BulkTrashResult> {
  const moved: string[] = [];
  const skipped: BulkSkip[] = [];
  for (const t of targets) {
    try {
      await request(t.id);
      moved.push(t.id);
    } catch (err: unknown) {
      skipped.push({
        id: t.id,
        name: t.name,
        reason: err instanceof Error ? err.message : '削除できませんでした',
      });
    }
  }
  return { moved, skipped };
}

/** 一括移動の結果を 1 行の通知文にする。 */
export function formatBulkTrashResult(r: BulkTrashResult): string {
  const head = `${r.moved.length} 件をゴミ箱へ移動しました`;
  if (r.skipped.length === 0) return head;
  const detail = r.skipped.map((s) => `${s.name}: ${s.reason}`).join(' / ');
  return `${head}。${r.skipped.length} 件はスキップしました（${detail}）`;
}

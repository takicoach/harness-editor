import type { ProjectSummary } from '../../shared/types';
import { DISPLAY_STATUSES, STATUS_LABEL, type DisplayStatus } from '../../shared/projectStage';

/** カンバンの列定義。共有ドメイン DISPLAY_STATUSES（制作フロー順）から派生する。 */
export const KANBAN_COLUMNS: Array<{ status: DisplayStatus; label: string }> = DISPLAY_STATUSES.map(
  (status) => ({ status, label: STATUS_LABEL[status] }),
);

export interface KanbanColumn {
  status: DisplayStatus;
  label: string;
  projects: ProjectSummary[];
}

/**
 * プロジェクト一覧をステータス列へ振り分ける。列は KANBAN_COLUMNS の順で常に6つ返す
 * （空列も返す＝フローのどこにいるかが常に見えるようにする）。
 * 列内は最終編集が新しい順（未編集は末尾・元の並び維持）。同列内の手動並び替えは仕様として
 * 持たない（列間移動専用 — Codex レビュー P1「列内順序未定義」の裁定）。
 */
export function groupProjectsByStatus(projects: ProjectSummary[]): KanbanColumn[] {
  return KANBAN_COLUMNS.map(({ status, label }) => ({
    status,
    label,
    projects: projects
      .filter((p) => p.status === status)
      .sort((a, b) => (b.lastEditedAt ?? 0) - (a.lastEditedAt ?? 0)),
  }));
}

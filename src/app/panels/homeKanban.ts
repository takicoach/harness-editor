import type { ProjectSummary } from '../../shared/types';

type ProjectStatus = ProjectSummary['status'];

/** カンバンの列定義。制作フロー順（次に編集するものが左端に来る）。 */
export const KANBAN_COLUMNS: Array<{ status: ProjectStatus; label: string }> = [
  { status: 'idle', label: '未着手' },
  { status: 'editing', label: '編集中' },
  { status: 'rendered', label: '書き出し済' },
  { status: 'review', label: 'レビュー待ち' },
  { status: 'published', label: '公開済' },
];

export interface KanbanColumn {
  status: ProjectStatus;
  label: string;
  projects: ProjectSummary[];
}

/**
 * プロジェクト一覧をステータス列へ振り分ける。列は KANBAN_COLUMNS の順で常に5つ返す
 * （空列も返す＝フローのどこにいるかが常に見えるようにする）。
 * 列内は最終編集が新しい順（未編集は末尾・元の並び維持）。
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

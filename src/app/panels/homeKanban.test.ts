import { describe, it, expect } from 'vitest';
import { groupProjectsByStatus, KANBAN_COLUMNS } from './homeKanban';
import type { ProjectSummary } from '../../shared/types';

function proj(id: string, status: ProjectSummary['status'], lastEditedAt?: number): ProjectSummary {
  return {
    id, name: id, orientation: 'h', durationLabel: '1:00', sizeLabel: '1 MB',
    videoFile: null, status, lastEditedAt,
  } as ProjectSummary;
}

describe('groupProjectsByStatus', () => {
  it('空でも常に5列（フロー順）を返す', () => {
    const cols = groupProjectsByStatus([]);
    expect(cols.map((c) => c.status)).toEqual(['idle', 'editing', 'rendered', 'review', 'published']);
    expect(cols.map((c) => c.label)).toEqual(KANBAN_COLUMNS.map((c) => c.label));
    expect(cols.every((c) => c.projects.length === 0)).toBe(true);
  });

  it('ステータスごとに振り分け、列内は最終編集が新しい順', () => {
    const cols = groupProjectsByStatus([
      proj('a', 'editing', 100),
      proj('b', 'rendered', 50),
      proj('c', 'editing', 300),
      proj('d', 'idle'),
      proj('e', 'editing'), // lastEditedAt 無し → 末尾
    ]);
    const byStatus = Object.fromEntries(cols.map((c) => [c.status, c.projects.map((p) => p.id)]));
    expect(byStatus['editing']).toEqual(['c', 'a', 'e']);
    expect(byStatus['rendered']).toEqual(['b']);
    expect(byStatus['idle']).toEqual(['d']);
    expect(byStatus['review']).toEqual([]);
    expect(byStatus['published']).toEqual([]);
  });
});

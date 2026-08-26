import { describe, it, expect } from 'vitest';
import { groupProjectsByStatus, KANBAN_COLUMNS } from './homeKanban';
import type { ProjectSummary } from '../../shared/types';
import { DISPLAY_STATUSES, STATUS_LABEL } from '../../shared/projectStage';

describe('KANBAN_COLUMNS（共有ドメイン派生）', () => {
  it('列は DISPLAY_STATUSES と同順・同ラベル（正本1箇所化の同期ガード）', () => {
    expect(KANBAN_COLUMNS.map((c) => c.status)).toEqual([...DISPLAY_STATUSES]);
    expect(KANBAN_COLUMNS.map((c) => c.label)).toEqual(DISPLAY_STATUSES.map((s) => STATUS_LABEL[s]));
  });
});

function proj(id: string, status: ProjectSummary['status'], lastEditedAt?: number): ProjectSummary {
  return {
    id, name: id, orientation: 'h', durationLabel: '1:00', sizeLabel: '1 MB',
    videoFile: null, status, lastEditedAt,
  } as ProjectSummary;
}

describe('groupProjectsByStatus', () => {
  it('空でも常に6列（工程順）を返す', () => {
    const cols = groupProjectsByStatus([]);
    expect(cols.map((c) => c.status)).toEqual([
      'idle',
      'transcribe',
      'cut',
      'telop',
      'audio',
      'rendered',
    ]);
    expect(cols.map((c) => c.label)).toEqual(KANBAN_COLUMNS.map((c) => c.label));
    expect(cols.every((c) => c.projects.length === 0)).toBe(true);
  });

  it('ステータスごとに振り分け、列内は最終編集が新しい順', () => {
    const cols = groupProjectsByStatus([
      proj('a', 'telop', 100),
      proj('b', 'rendered', 50),
      proj('c', 'telop', 300),
      proj('d', 'idle'),
      proj('e', 'telop'), // lastEditedAt 無し → 末尾
    ]);
    const byStatus = Object.fromEntries(cols.map((c) => [c.status, c.projects.map((p) => p.id)]));
    expect(byStatus['telop']).toEqual(['c', 'a', 'e']);
    expect(byStatus['rendered']).toEqual(['b']);
    expect(byStatus['idle']).toEqual(['d']);
    expect(byStatus['transcribe']).toEqual([]);
    expect(byStatus['cut']).toEqual([]);
    expect(byStatus['audio']).toEqual([]);
  });
});

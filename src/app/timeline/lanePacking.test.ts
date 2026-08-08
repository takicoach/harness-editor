import { describe, expect, it } from 'vitest';
import { assignLanes } from './lanePacking';

describe('assignLanes', () => {
  it('空入力は laneCount 0・lanes 空', () => {
    expect(assignLanes([])).toEqual({ lanes: [], laneCount: 0 });
  });

  it('単一区間はレーン 0', () => {
    expect(assignLanes([{ start: 0, end: 10 }])).toEqual({ lanes: [0], laneCount: 1 });
  });

  it('端が接するだけ（半開区間で非重なり）は同一レーン', () => {
    expect(assignLanes([{ start: 0, end: 10 }, { start: 10, end: 20 }])).toEqual({
      lanes: [0, 0],
      laneCount: 1,
    });
  });

  it('重なる 2 区間は別レーン', () => {
    expect(assignLanes([{ start: 0, end: 10 }, { start: 5, end: 15 }])).toEqual({
      lanes: [0, 1],
      laneCount: 2,
    });
  });

  it('3 つ重なるとレーン 0・1・2', () => {
    const r = assignLanes([
      { start: 0, end: 30 },
      { start: 5, end: 15 },
      { start: 10, end: 20 },
    ]);
    expect(r).toEqual({ lanes: [0, 1, 2], laneCount: 3 });
  });

  it('入れ子（長区間＋内側短区間）は別レーン', () => {
    expect(assignLanes([{ start: 0, end: 100 }, { start: 40, end: 50 }])).toEqual({
      lanes: [0, 1],
      laneCount: 2,
    });
  });

  it('入力が start 昇順でなくても結果は入力順に整列して返る', () => {
    // A{10,20} と B{0,5} は重ならない → 同一レーン
    expect(assignLanes([{ start: 10, end: 20 }, { start: 0, end: 5 }])).toEqual({
      lanes: [0, 0],
      laneCount: 1,
    });
  });

  it('同 start は元インデックス順で決定的に割り当て', () => {
    expect(assignLanes([{ start: 0, end: 10 }, { start: 0, end: 20 }])).toEqual({
      lanes: [0, 1],
      laneCount: 2,
    });
  });

  it('前の区間が終わったレーンへ後続が再利用される', () => {
    // A[0,5), B[2,8), C[6,10) → A:レーン0, B:レーン1, C:レーン0（laneEnds[0]=5 <= 6 で再利用）
    const r = assignLanes([
      { start: 0, end: 5 },
      { start: 2, end: 8 },
      { start: 6, end: 10 },
    ]);
    expect(r).toEqual({ lanes: [0, 1, 0], laneCount: 2 });
  });
});

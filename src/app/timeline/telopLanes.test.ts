import { describe, it, expect } from 'vitest';
import { assignTelopLanes } from './telopLanes';

describe('assignTelopLanes', () => {
  it('空入力は laneCount 0', () => {
    expect(assignTelopLanes([])).toEqual({ lanes: [], laneCount: 0 });
  });
  it('字幕のみ（非重なり）は全 lane 0', () => {
    const r = assignTelopLanes([
      { start: 0, end: 10, manual: false },
      { start: 20, end: 30, manual: false },
    ]);
    expect(r.lanes).toEqual([0, 0]);
    expect(r.laneCount).toBe(1);
  });
  it('字幕のみ（重なり）でも全 lane 0（同段固定）', () => {
    const r = assignTelopLanes([
      { start: 0, end: 30, manual: false },
      { start: 10, end: 40, manual: false },
    ]);
    expect(r.lanes).toEqual([0, 0]);
    expect(r.laneCount).toBe(1);
  });
  it('字幕が3本重なっても全 lane 0・laneCount 1（段を増やさない）', () => {
    const r = assignTelopLanes([
      { start: 0, end: 50, manual: false },
      { start: 10, end: 60, manual: false },
      { start: 20, end: 70, manual: false },
    ]);
    expect(r.lanes).toEqual([0, 0, 0]);
    expect(r.laneCount).toBe(1);
  });
  it('字幕＋装飾は字幕 lane 0・装飾 lane 1', () => {
    const r = assignTelopLanes([
      { start: 0, end: 30, manual: false },
      { start: 0, end: 30, manual: true },
    ]);
    expect(r.lanes).toEqual([0, 1]);
    expect(r.laneCount).toBe(2);
  });
  it('装飾が重なると装飾内で lane 1,2（字幕あり時）', () => {
    const r = assignTelopLanes([
      { start: 0, end: 100, manual: false },
      { start: 0, end: 30, manual: true },
      { start: 10, end: 40, manual: true },
    ]);
    expect(r.lanes).toEqual([0, 1, 2]);
    expect(r.laneCount).toBe(3);
  });
  it('装飾のみ（字幕なし）は lane 0 から段組み', () => {
    const r = assignTelopLanes([
      { start: 0, end: 30, manual: true },
      { start: 10, end: 40, manual: true },
    ]);
    expect(r.lanes).toEqual([0, 1]);
    expect(r.laneCount).toBe(2);
  });
});

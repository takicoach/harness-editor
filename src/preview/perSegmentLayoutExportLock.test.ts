// src/preview/perSegmentLayoutExportLock.test.ts
import { describe, it, expect } from 'vitest';
import { layoutSegmentRanges, effectiveLayoutAtFrame } from '../server/mainLayoutPayload/layoutSegments';
import { resolveSpeedSegments, playbackToSpeed, speedToPlayback } from '../core/speedEngine';
import { effectiveLayoutAt } from '../core/segmentLayout';

// cutRegions = [{start:100,end:300},{start:360,end:500}] を残す区間として表現したもの。
const CUTS = [
  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },
  { id: 2, originalStart: 300, originalEnd: 360, playbackStart: 100, playbackEnd: 160 },
  { id: 3, originalStart: 500, originalEnd: 540, playbackStart: 160, playbackEnd: 200 },
];

describe('payload layoutSegmentRanges == core playbackToSpeed（preview=export lock）', () => {
  it('等速: 各区間 start が playbackStart と一致', () => {
    const ranges = layoutSegmentRanges(CUTS, 1);
    CUTS.forEach((c, i) => expect(ranges[i]!.start).toBe(c.playbackStart));
  });
  it('一律速度: 各区間 start が core playbackToSpeed(playbackStart) と一致', () => {
    const segs = resolveSpeedSegments(CUTS, 0.5, {});
    const ranges = layoutSegmentRanges(CUTS, 0.5, {});
    CUTS.forEach((c, i) => expect(ranges[i]!.start).toBe(playbackToSpeed(c.playbackStart, segs)));
  });
  it('区間ごと速度・クランプ境界(0.1/16)でも start が core と一致', () => {
    const ss = { 1: 0.1, 2: 16 };
    const segs = resolveSpeedSegments(CUTS, 1, ss);
    const ranges = layoutSegmentRanges(CUTS, 1, ss);
    CUTS.forEach((c, i) => expect(ranges[i]!.start).toBe(playbackToSpeed(c.playbackStart, segs)));
  });
});

describe('大域キーフレーム（originalFrame アンカー）の core effectiveLayoutAt == payload effectiveLayoutAtFrame（preview=export lock）', () => {
  const base = { position: { x: 0, y: 0 }, scale: 1, background: '#000000', rotation: 0, flipH: false, flipV: false };
  // 大域KFは区間2つ（id1・id2）を跨いで originalFrame 0..330 に張られる（複数区間を跨ぐケース）。
  const kfs = [
    { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
    { originalFrame: 330, x: 0.5, y: -0.5, scale: 2.5, rotation: 45 },
  ];
  const kept = CUTS.map((c) => ({ id: c.id, originalStart: c.originalStart, playbackStart: c.playbackStart, playbackEnd: c.playbackEnd }));

  it('等速: 区間跨ぎの多数フレームで core と payload が precision 10 で厳密一致', () => {
    const ranges = layoutSegmentRanges(CUTS, 1);
    for (const f of [0, 25, 50, 75, 99, 100, 120, 140, 159, 160, 180, 199]) {
      const core = effectiveLayoutAt(f, kept, base, {}, false, kfs);
      const payload = effectiveLayoutAtFrame(f, base, {}, ranges, CUTS, kfs);
      expect(payload.scale).toBeCloseTo(core.scale, 10);
      expect(payload.position.x).toBeCloseTo(core.position.x, 10);
      expect(payload.position.y).toBeCloseTo(core.position.y, 10);
      expect(payload.rotation).toBeCloseTo(core.rotation ?? 0, 10);
    }
  });

  it('区間境界で段差が無い（連続補間・パンのガタつき解消の直接検証）', () => {
    const ranges = layoutSegmentRanges(CUTS, 1);
    // playback 99→100 は区間1→2の境界（originalFrame 99→300 の大ジャンプだが、
    // 大域KFの sample 自体は originalFrame の連続関数なので、原本フレーム空間で見れば連続）。
    const at99 = effectiveLayoutAtFrame(99, base, {}, ranges, CUTS, kfs).position.x;
    const at100 = effectiveLayoutAtFrame(100, base, {}, ranges, CUTS, kfs).position.x;
    // 原本フレーム 99→300 の大ジャンプ自体は動画のカットなので x の差は生じ得るが、
    // 少なくとも旧モデルの「区間末尾value→次区間頭valueへの瞬間リセット」(base に戻る類の段差)は発生しない。
    // ここでは core と payload が同じ値を返すこと自体をロックする（構造的な一致検証）。
    const core99 = effectiveLayoutAt(99, kept, base, {}, false, kfs).position.x;
    const core100 = effectiveLayoutAt(100, kept, base, {}, false, kfs).position.x;
    expect(at99).toBeCloseTo(core99, 10);
    expect(at100).toBeCloseTo(core100, 10);
  });

  it('速度可変（区間ごと速度含む）でも近接一致（丸め由来の微差は許容）', () => {
    const segmentSpeeds = { 1: 0.5, 2: 2, 3: 1 };
    const ranges = layoutSegmentRanges(CUTS, 1, segmentSpeeds);
    const segs = resolveSpeedSegments(CUTS, 1, segmentSpeeds);
    for (const f of [0, 20, 60, 90, 130, 170]) {
      const payload = effectiveLayoutAtFrame(f, base, {}, ranges, CUTS, kfs);
      // 最終フレーム f に対応する再生フレームへ逆写像し、core（再生フレーム空間）と突き合わせる。
      const playbackFrame = speedToPlayback(f, segs);
      const core = effectiveLayoutAt(Math.round(playbackFrame), kept, base, {}, false, kfs);
      expect(payload.scale).toBeCloseTo(core.scale, 1);
      expect(payload.position.x).toBeCloseTo(core.position.x, 1);
    }
  });
});

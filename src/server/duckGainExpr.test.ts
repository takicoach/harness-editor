import { describe, expect, it } from 'vitest';
import {
  buildDuckGainAst,
  buildDuckGainExpr,
  evalDuckGainAst,
  DuckGainRegionLimitExceededError,
  MAX_DUCK_REGIONS,
} from './duckGainExpr';
import { duckFactorAt } from '../core/ducking';
import type { DuckEnvelope } from '../core/types';

const FPS = 30;
const CLIP_LEN = 300; // 全フレーム照合の走査範囲（region 群を余裕を持って包含）

/** ast/duckFactorAt を全フレーム＋羽根境界前後で照合する。 */
function assertEquivalent(env: DuckEnvelope, fps: number, clipLen: number): void {
  const ast = buildDuckGainAst(env, fps);
  expect(ast).not.toBeNull();
  for (let n = 0; n < clipLen; n++) {
    const t = n / fps;
    const expected = duckFactorAt(n, env);
    const actual = evalDuckGainAst(ast!, t);
    expect(actual).toBeCloseTo(expected, 9);
  }
}

describe('buildDuckGainExpr / buildDuckGainAst 同値証明', () => {
  it('env 無し / regions 空なら null', () => {
    expect(buildDuckGainExpr(undefined, FPS)).toBeNull();
    expect(buildDuckGainExpr({ regions: [], gain: 0.5, attackFrames: 3, releaseFrames: 9 }, FPS)).toBeNull();
  });

  it('(i) 単一 region が羽根込みでクリップ内に収まる', () => {
    const env: DuckEnvelope = {
      regions: [{ start: 100, end: 200 }],
      gain: 0.25,
      attackFrames: 3,
      releaseFrames: 9,
    };
    assertEquivalent(env, FPS, CLIP_LEN);
  });

  it('(ii) 隣接2 region の release と attack が重なり min が効く', () => {
    const region1 = { start: 50, end: 100 };
    const region2 = { start: 105, end: 150 };
    const env: DuckEnvelope = {
      regions: [region1, region2],
      gain: 0.5,
      attackFrames: 3,
      releaseFrames: 9,
    };
    // release-of-1 [100,109) と attack-of-2 [102,105) が重なる区間を実際に通過することを確認する
    let sawOverlapWhereMinMatters = false;
    for (let n = 100; n < 109; n++) {
      const withoutRegion2 = duckFactorAt(n, { ...env, regions: [region1] });
      const combined = duckFactorAt(n, env);
      if (combined < withoutRegion2 - 1e-9) sawOverlapWhereMinMatters = true;
    }
    expect(sawOverlapWhereMinMatters).toBe(true);
    assertEquivalent(env, FPS, CLIP_LEN);
  });

  it('(iii) region の羽根がクリップ端をはみ出す', () => {
    const env: DuckEnvelope = {
      regions: [{ start: 1, end: 3 }],
      gain: 0.4,
      attackFrames: 5, // attackStart = -4 → クリップ先頭(0)より前へはみ出す
      releaseFrames: 5,
    };
    assertEquivalent(env, FPS, CLIP_LEN);
  });

  it('羽根の境界フレーム前後をピンポイントでも照合する', () => {
    const env: DuckEnvelope = {
      regions: [{ start: 40, end: 60 }],
      gain: 0.6,
      attackFrames: 4,
      releaseFrames: 6,
    };
    const ast = buildDuckGainAst(env, FPS)!;
    const boundaries = [40 - 4, 40, 60, 60 + 6];
    for (const b of boundaries) {
      for (const n of [b - 1, b, b + 1]) {
        const t = n / FPS;
        expect(evalDuckGainAst(ast, t)).toBeCloseTo(duckFactorAt(n, env), 9);
      }
    }
  });

  it('文字列出力の形: min( を含み・t 基準・between( は使わない', () => {
    const env: DuckEnvelope = {
      regions: [
        { start: 50, end: 100 },
        { start: 105, end: 150 },
      ],
      gain: 0.5,
      attackFrames: 3,
      releaseFrames: 9,
    };
    const expr = buildDuckGainExpr(env, FPS)!;
    expect(expr).toContain('min(');
    expect(expr).toContain('t');
    expect(expr).not.toContain('between(');
  });

  it('attackFrames<=0 は attack 羽根を省略する（防御・0除算しない）', () => {
    const env: DuckEnvelope = {
      regions: [{ start: 50, end: 100 }],
      gain: 0.5,
      attackFrames: 0,
      releaseFrames: 9,
    };
    expect(() => buildDuckGainExpr(env, FPS)).not.toThrow();
    assertEquivalent(env, FPS, CLIP_LEN);
  });

  it('releaseFrames<=0 は release 羽根を省略する（防御・0除算しない）', () => {
    const env: DuckEnvelope = {
      regions: [{ start: 50, end: 100 }],
      gain: 0.5,
      attackFrames: 3,
      releaseFrames: 0,
    };
    expect(() => buildDuckGainExpr(env, FPS)).not.toThrow();
    assertEquivalent(env, FPS, CLIP_LEN);
  });

  it('C-1 安全弁: region 数が MAX_DUCK_REGIONS を超えると DuckGainRegionLimitExceededError（null と区別された明示的失敗）', () => {
    const regions = Array.from({ length: MAX_DUCK_REGIONS + 1 }, (_, i) => ({ start: i * 100, end: i * 100 + 20 }));
    const env: DuckEnvelope = { regions, gain: 0.5, attackFrames: 3, releaseFrames: 9 };
    expect(() => buildDuckGainAst(env, FPS)).toThrow(DuckGainRegionLimitExceededError);
    expect(() => buildDuckGainExpr(env, FPS)).toThrow(DuckGainRegionLimitExceededError);
  });

  it('C-1 安全弁: region 数が MAX_DUCK_REGIONS ちょうどなら通る（境界）', () => {
    const regions = Array.from({ length: MAX_DUCK_REGIONS }, (_, i) => ({ start: i * 100, end: i * 100 + 20 }));
    const env: DuckEnvelope = { regions, gain: 0.5, attackFrames: 3, releaseFrames: 9 };
    expect(() => buildDuckGainAst(env, FPS)).not.toThrow();
  });
});

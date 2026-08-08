// src/server/systemLoad.test.ts — 重ジョブ負荷ゲートの算出表・allowed/409形・force貫通を検証。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { recommendedMaxHeavyJobs, heavyJobGate, heavyJobCounts } from './systemLoad';

const GB = 1024 ** 3;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('recommendedMaxHeavyJobs', () => {
  it('(10コア,24GB) → 2', () => {
    expect(recommendedMaxHeavyJobs(10, 24 * GB)).toBe(2);
  });

  it('(4コア,8GB) → 1（下限1で切り上げ）', () => {
    expect(recommendedMaxHeavyJobs(4, 8 * GB)).toBe(1);
  });

  it('(16コア,64GB) → 4', () => {
    expect(recommendedMaxHeavyJobs(16, 64 * GB)).toBe(4);
  });

  it("envOverride '5' → 5（環境変数優先）", () => {
    expect(recommendedMaxHeavyJobs(10, 24 * GB, '5')).toBe(5);
  });

  it("envOverride '0' → 算出値へフォールバック", () => {
    expect(recommendedMaxHeavyJobs(10, 24 * GB, '0')).toBe(2);
  });

  it("envOverride 'abc' → 算出値へフォールバック", () => {
    expect(recommendedMaxHeavyJobs(10, 24 * GB, 'abc')).toBe(2);
  });
});

describe('heavyJobGate', () => {
  it('running < recommendedMax なら allowed:true', () => {
    const result = heavyJobGate(false, {
      counts: [() => 0],
      cores: 10,
      memBytes: 24 * GB,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('running >= recommendedMax なら 409 形（confirmation-required 相当）で拒否する', () => {
    const result = heavyJobGate(false, {
      counts: [() => 1, () => 1],
      cores: 4,
      memBytes: 8 * GB,
    });
    expect(result).toEqual({ allowed: false, running: 2, recommendedMax: 1 });
  });

  it('force:true は running が上限以上でも allowed:true を貫通させる', () => {
    const result = heavyJobGate(true, {
      counts: [() => 5],
      cores: 4,
      memBytes: 8 * GB,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('複数 counts の合計で running を算出する', () => {
    const result = heavyJobGate(false, {
      counts: [() => 1, () => 0, () => 1],
      cores: 16,
      memBytes: 64 * GB,
    });
    expect(result).toEqual({ allowed: true });
  });

  it('SME_MAX_HEAVY_JOBS 環境変数で recommendedMax を上書きしてゲートする', () => {
    vi.stubEnv('SME_MAX_HEAVY_JOBS', '1');
    const result = heavyJobGate(false, {
      counts: [() => 1],
      cores: 10,
      memBytes: 24 * GB,
    });
    expect(result).toEqual({ allowed: false, running: 1, recommendedMax: 1 });
  });
});

describe('heavyJobCounts', () => {
  it('5 マネージャ分の activeCount クロージャを返す（既定は全て 0）', () => {
    const counts = heavyJobCounts();
    expect(counts).toHaveLength(5);
    for (const count of counts) {
      expect(typeof count).toBe('function');
      expect(count()).toBe(0);
    }
  });
});

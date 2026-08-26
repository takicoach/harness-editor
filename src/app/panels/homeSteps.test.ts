import { describe, it, expect } from 'vitest';
import { STEP_LABEL, STEP_ORDER } from './HomeDashboard';

describe('工程ステッパーの定義', () => {
  // STEP_LABEL は Record<keyof ProjectSteps, string> なのでラベルの網羅は型が守る。
  // 表示順の配列だけは型で網羅を強制できないため、キー数の一致をテストで担保する。
  it('STEP_ORDER が STEP_LABEL の全キーを過不足なく並べる', () => {
    expect(STEP_ORDER).toHaveLength(Object.keys(STEP_LABEL).length);
    expect([...STEP_ORDER].sort()).toEqual(Object.keys(STEP_LABEL).sort());
  });
});

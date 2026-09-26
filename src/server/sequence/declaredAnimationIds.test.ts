import { describe, expect, it } from 'vitest';
import { declaredAnimationIds } from './textStyles';

describe('declaredAnimationIds', () => {
  it('直接 export した宣言を読む', () => {
    expect(declaredAnimationIds(`export const TELOP_ANIMATIONS = ['none','popIn'];\nexport const Telop = () => null;`))
      .toEqual(['none', 'popIn']);
  });

  it('esbuild が畳んだ export 句からも実体を引く（名前を当て推量しない）', () => {
    expect(declaredAnimationIds(`var LIST2 = ['none','wipeReveal'];\nvar Telop = () => null;\nexport { Telop, LIST2 as TELOP_ANIMATIONS };`))
      .toEqual(['none', 'wipeReveal']);
  });

  it('as const を剥がす', () => {
    expect(declaredAnimationIds(`export const TELOP_ANIMATIONS = ['none'] as const;`)).toEqual(['none']);
  });

  it('宣言が無ければ不明（null）', () => {
    expect(declaredAnimationIds(`export const Telop = () => null;`)).toBeNull();
    expect(declaredAnimationIds(`const TELOP_ANIMATIONS = ['none'];`)).toBeNull();   // export していない
  });

  it('文字列以外が混ざったら不明（推定しない）', () => {
    expect(declaredAnimationIds(`export const TELOP_ANIMATIONS = ['none', SOMETHING];`)).toBeNull();
    expect(declaredAnimationIds(`export const TELOP_ANIMATIONS = KNOWN_LIST;`)).toBeNull();
  });

  it('本文に動きの名前が書いてあるだけでは拾わない', () => {
    expect(declaredAnimationIds(`export const Telop = ({segment}) => segment.animation === 'popIn' ? null : null;`)).toBeNull();
  });
});

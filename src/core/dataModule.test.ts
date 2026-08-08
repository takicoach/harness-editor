import { describe, it, expect } from 'vitest';
import { evalDataModule } from './dataModule';

describe('evalDataModule', () => {
  it('式を含む export を評価できる', () => {
    const out = evalDataModule('export const x = 1 + 2;');
    expect(out.x).toBe(3);
  });

  it('型注釈を剥がしてファイル内関数を実行できる', () => {
    const src = 'const toFrame = (ms: number): number => ms * 2;\nexport const a = [toFrame(3)];';
    const out = evalDataModule(src);
    expect(out.a).toEqual([6]);
  });

  it('import をスタブで差し替える', () => {
    const src =
      "import { FPS } from '../videoConfig';\nexport const f = FPS;";
    const out = evalDataModule(src, { '../videoConfig': { FPS: 60 } });
    expect(out.f).toBe(60);
  });

  it('未登録の import は空オブジェクトになる', () => {
    const src = "import type { T } from './telopTypes';\nexport const v = 1;";
    const out = evalDataModule(src, {});
    expect(out.v).toBe(1);
  });
});

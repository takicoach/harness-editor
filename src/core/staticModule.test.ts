import { describe, it, expect } from 'vitest';
import { readModuleExportsStatic, StaticEvalError } from './staticModule';

describe('readModuleExportsStatic', () => {
  it('リテラルの export を取り出す', () => {
    const m = readModuleExportsStatic(`
      export const FORMAT = 'short';
      export const FPS = 60;
      export const NEG = -12;
      export const FLAG = true;
      export const NAME = 'main.mp4';
    `);
    expect(m).toMatchObject({ FORMAT: 'short', FPS: 60, NEG: -12, FLAG: true, NAME: 'main.mp4' });
  });

  it('const マップのインデックスアクセス（RESOLUTION_MAP[FORMAT]）を解決する', () => {
    const m = readModuleExportsStatic(`
      export const FORMAT = 'short';
      const RESOLUTION_MAP = {
        youtube: { width: 1920, height: 1080 },
        short: { width: 1080, height: 1920 },
      } as const;
      export const RESOLUTION = RESOLUTION_MAP[FORMAT];
    `);
    expect(m.RESOLUTION).toEqual({ width: 1080, height: 1920 });
  });

  it('宣言順が後でも前方参照を解決する', () => {
    const m = readModuleExportsStatic(`
      export const RESOLUTION = MAP[FORMAT];
      const MAP = { a: 1, b: 2 } as const;
      export const FORMAT = 'b';
    `);
    expect(m.RESOLUTION).toBe(2);
  });

  it('外部注入値（FPS 等）を識別子として解決する', () => {
    const m = readModuleExportsStatic(
      `export const TOTAL = FPS;`,
      { FPS: 30 },
    );
    expect(m.TOTAL).toBe(30);
  });

  it('配列・ネストオブジェクトを読める', () => {
    const m = readModuleExportsStatic(`
      export const seData = [{ id: 1, file: 'a.mp3', volume: 0.5 }, { id: 2, file: 'b.mp3', volume: 1 }];
    `);
    expect(m.seData).toEqual([
      { id: 1, file: 'a.mp3', volume: 0.5 },
      { id: 2, file: 'b.mp3', volume: 1 },
    ]);
  });

  // --- セキュリティ: コードを実行しないことの検証 ---

  it('関数呼び出しを含む式は StaticEvalError（実行しない）', () => {
    expect(() =>
      readModuleExportsStatic(`
        const toFrame = (s) => s * 30;
        export const X = toFrame(2);
      `),
    ).toThrow(StaticEvalError);
  });

  it('サンドボックス脱出（this.constructor.constructor）を評価せず投げる', () => {
    // vm 実行版ならホストの process へ到達しうる式。静的版は実行せず例外にする。
    const malicious = `
      export const FORMAT = (this).constructor.constructor('return process')().mainModule;
    `;
    expect(() => readModuleExportsStatic(malicious)).toThrow(StaticEvalError);
  });

  it('IIFE による副作用を実行しない（グローバル汚染が起きない）', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__SME_PWNED__;
    const malicious = `
      export const FPS = (() => { globalThis.__SME_PWNED__ = true; return 30; })();
    `;
    expect(() => readModuleExportsStatic(malicious)).toThrow(StaticEvalError);
    expect(g.__SME_PWNED__).toBeUndefined();
  });

  it('getter / メソッド / spread / computed key / tagged template を評価せず投げる', () => {
    const cases = [
      `export const X = { get a() { return 1; } };`,
      `export const X = { a() { return 1; } };`,
      `const Y = { b: 1 }; export const X = { ...Y };`,
      `const K = 'a'; export const X = { [K]: 1 };`,
      'export const X = String`hi`;',
      `export const X = new Object();`,
      `export const X = 1 + 2;`,
      `export const X = true ? 1 : 2;`,
    ];
    for (const src of cases) {
      expect(() => readModuleExportsStatic(src), src).toThrow(StaticEvalError);
    }
  });

  it('オブジェクトの __proto__ キー（prototype 差し替え）を拒否する', () => {
    expect(() =>
      readModuleExportsStatic(`export const X = { __proto__: { polluted: true } };`),
    ).toThrow(StaticEvalError);
    // グローバル Object.prototype が汚染されていないこと
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('bare 識別子 constructor / toString（prototype 由来）を未定義として投げる', () => {
    expect(() => readModuleExportsStatic(`export const X = constructor;`)).toThrow(StaticEvalError);
    expect(() => readModuleExportsStatic(`export const X = toString;`)).toThrow(StaticEvalError);
  });

  it('({}).constructor は関数値を生成せず undefined（own でない参照は辿らない）', () => {
    const m = readModuleExportsStatic(`export const X = ({}).constructor;`);
    expect(m.X).toBeUndefined();
    // 配列やオブジェクトの constructor 参照も関数を返さない
    expect(readModuleExportsStatic(`const O = { a: 1 }; export const X = O.constructor;`).X).toBeUndefined();
  });

  it('export 名 __proto__ を拒否する（exportマップの prototype 差し替え防止）', () => {
    const src = `export const __proto__ = { FORMAT: 'short', FPS: 30 };`;
    expect(() => readModuleExportsStatic(src)).toThrow(StaticEvalError);
    // グローバル Object.prototype も汚染されない
    expect(({} as Record<string, unknown>).FORMAT).toBeUndefined();
  });

  it('constructor / prototype を export 名・オブジェクトキーとして拒否する', () => {
    expect(() => readModuleExportsStatic(`export const constructor = 1;`)).toThrow(StaticEvalError);
    expect(() => readModuleExportsStatic(`export const prototype = 1;`)).toThrow(StaticEvalError);
    expect(() => readModuleExportsStatic(`export const X = { constructor: 1 };`)).toThrow(StaticEvalError);
    expect(() => readModuleExportsStatic(`export const X = { prototype: 1 };`)).toThrow(StaticEvalError);
  });
});

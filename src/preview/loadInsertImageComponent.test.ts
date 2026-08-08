import { describe, expect, it } from 'vitest';
import { pickInsertImageExport } from './loadInsertImageComponent';

describe('pickInsertImageExport', () => {
  it('InsertImage export を返す', () => {
    const fakeComponent = (() => null) as unknown;
    const mod = { InsertImage: fakeComponent };
    expect(pickInsertImageExport(mod)).toBe(fakeComponent);
  });

  it('InsertImage 不在なら日本語メッセージで throw', () => {
    expect(() => pickInsertImageExport({})).toThrow(
      /InsertImage.*src\/InsertImage\/InsertImage\.tsx/,
    );
  });

  it('InsertImage が関数でなければ throw', () => {
    expect(() => pickInsertImageExport({ InsertImage: 'not a fn' })).toThrow();
  });
});

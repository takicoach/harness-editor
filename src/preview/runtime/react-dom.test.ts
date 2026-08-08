import { describe, it, expect } from 'vitest';
import * as runtime from './react-dom';
import * as reactDom from 'react-dom';
import { createPortal } from 'react-dom';

// import map で 'react-dom' に割り当てる再エクスポートモジュールの検証。
// 特に `export { default }` は react-dom(CJS) の interop に依存するため、
// 外部テロップ部品が default import した瞬間に壊れていないかをここで固定する。
describe('preview/runtime/react-dom', () => {
  it('default export が存在し、react-dom 本体と同一 API を指す', () => {
    expect(runtime.default).toBeDefined();
    expect(runtime.default.createPortal).toBe(createPortal);
  });

  it('named export も react-dom 本体と同一インスタンス', () => {
    expect(runtime.createPortal).toBe(reactDom.createPortal);
    expect(runtime.version).toBe(reactDom.version);
  });
});

// 外部テロップ部品が react-dom を直接 import した場合に備えた再エクスポート。
// react.ts と同様、Vite が重複排除しエディタ本体と同一インスタンスになる。
//
// 注意: react-dom は CJS のため `export * from 'react-dom'` では Vite が
// named export を静的に列挙できず、ブラウザで
// 「does not provide an export named 'createPortal'」になる（R-10 で顕在化）。
// named import 文は Vite の CJS interop で正しく解決されるため、
// 公開 API を明示的に import → re-export する。
import {
  createPortal,
  findDOMNode,
  flushSync,
  hydrate,
  render,
  unmountComponentAtNode,
  unstable_batchedUpdates,
  version,
} from 'react-dom';
import ReactDOM from 'react-dom';

export {
  createPortal,
  findDOMNode,
  flushSync,
  hydrate,
  render,
  unmountComponentAtNode,
  unstable_batchedUpdates,
  version,
};
export default ReactDOM;

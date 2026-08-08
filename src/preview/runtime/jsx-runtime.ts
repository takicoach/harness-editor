// react/jsx-runtime は CJS モジュール。Vite は CJS の名前付き export を
// `export *` で再エクスポートできない（起動時に interop 警告）。Vite の指示どおり
// 既知の名前（jsx / jsxs / Fragment）を明示的に再エクスポートする。
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
export { Fragment, jsx, jsxs };

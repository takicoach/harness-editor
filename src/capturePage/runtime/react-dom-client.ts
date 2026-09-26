// 撮影ページの importmap が 'react-dom/client' を解決する先。
// react / react-dom / react/jsx-runtime はプレビュー用の既存再エクスポート
// （src/preview/runtime/*.ts）を URL 参照で使い回す（ファイルは変更しない）。
// 'react-dom/client' だけはプレビュー側に無いため撮影ページ側で持つ。
//
// 注意: react-dom は CJS のため `export * from 'react-dom/client'` では Vite が
// named export を静的に列挙できない（src/preview/runtime/react-dom.ts のコメント参照）。
// 既知の名前を明示的に import → re-export する。
import { createRoot, hydrateRoot } from 'react-dom/client';
export { createRoot, hydrateRoot };

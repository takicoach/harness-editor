/**
 * 撮影ページの HTML（M2b T2・設計判断1/4）。
 *
 * プレビュー本体（index.html）とは別の面。importmap の 'remotion' と '@harness/frame-runtime' を
 * **captureRuntime バレルのブラウザバンドル**（/capture/runtime.js）へ向けることで、
 * プロジェクトの Telop / TitleLayer / InsertImage が real remotion ではなく撮影用ランタイム
 * の上で動く。react 系はプレビュー用の既存再エクスポート（src/preview/runtime/*.ts）を
 * URL 参照で使い回す（ファイルには触れない。CJS interop の都合で `export *` が使えず、
 * 明示再エクスポートが必要なため既存の実績ある実装を共有する）。
 *
 * 背景は塗らない: `page.screenshot({ omitBackground: true })` で透過 PNG を得る前提
 * （設計判断4）。viewport = 出力解像度は撮影ドライバ（T3）の責務。
 */

/** 撮影ページの importmap（route パスの正本）。 */
export const CAPTURE_IMPORTMAP: { imports: Record<string, string> } = {
  imports: {
    react: '/src/preview/runtime/react.ts',
    'react-dom': '/src/preview/runtime/react-dom.ts',
    'react-dom/client': '/src/capturePage/runtime/react-dom-client.ts',
    'react/jsx-runtime': '/src/preview/runtime/jsx-runtime.ts',
    'react/jsx-dev-runtime': '/src/preview/runtime/jsx-dev-runtime.ts',
    remotion: '/capture/runtime.js',
    '@harness/frame-runtime': '/capture/runtime.js',
  },
};

/** 撮影ページの HTML を組み立てる。 */
export function buildCapturePageHtml(): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <title>Harness Editor capture</title>
    <script type="importmap">
${JSON.stringify(CAPTURE_IMPORTMAP, null, 2)}
    </script>
    <style>
      /* omitBackground 撮影の前提: どの層にも地の色を塗らない（透過のまま撮る）。 */
      html,
      body,
      #capture-root {
        background: transparent;
      }
      html,
      body {
        margin: 0;
        padding: 0;
        overflow: hidden;
      }
      /* オーバーレイは合成座標の原点に置く。サイズは viewport（= 出力解像度）に一致させる。 */
      #capture-root {
        position: fixed;
        inset: 0;
      }
    </style>
  </head>
  <body>
    <div id="capture-root"></div>
    <script type="module" src="/capture/entry.js"></script>
  </body>
</html>
`;
}

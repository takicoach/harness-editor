/**
 * 動画素材として認識する拡張子の**単一の正本**。
 *
 * 以前は HomeDashboard（ホームD&D）／app/uploadMaterial（アップロード分類）／
 * server/loadProjectFiles（素材列挙・作成/リンクの検証）／file input の accept 属性の
 * 4 箇所に同じリテラルが独立して書かれており、片方だけ拡張子を足すと
 * 「ドロップは弾かれるのに accept には出る」といった食い違いが静かに生まれた
 * （バッチE レビュー指摘④）。追加はここ 1 箇所だけで済むようにする。
 *
 * クライアントとサーバの両方から import するため `src/shared/` に置く。
 */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v'];

/**
 * `<input type="file">` の accept 属性。MIME 型と上記拡張子の両建て
 * （OS・ブラウザによってどちらでフィルタされるかが違うため）。
 */
export const VIDEO_ACCEPT = ['video/mp4', 'video/quicktime', 'video/webm', ...VIDEO_EXTENSIONS].join(',');

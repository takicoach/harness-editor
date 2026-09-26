/**
 * 機能パック導入（install）の種別と API 対応表。
 *
 * 以前は installingPack / installError を全 install で共有していたため、
 * 片方の失敗が別機能の CTA/バナーに表示されるフットガンがあった（残課題 #5）。
 * ここで kind を型として固定し、App は kind 別の進行状態・エラーを持つ。
 */

/** エディタから導入できる機能パックの種別。 */
export type InstallKind =
  | 'telopPack'
  | 'videoInsert'
  | 'bgm'
  | 'shape'
  | 'transition'
  | 'speed'
  | 'imageRendering'
  | 'mainLayout';

/** kind 別の導入エラー。未発生の kind はキー無し。 */
export type InstallErrors = Partial<Record<InstallKind, string>>;

/** kind → 導入 API パスと、レスポンスに error が無いときの既定失敗メッセージ。 */
export const INSTALL_APIS: Record<InstallKind, { path: string; failMessage: string }> = {
  imageRendering: { path: '/api/install-image-rendering', failMessage: '画像表示の更新に失敗しました' },
  telopPack: { path: '/api/install-telop-pack', failMessage: 'テロップパックの導入に失敗しました' },
  videoInsert: { path: '/api/install-video-insert', failMessage: 'サブ動画機能の導入に失敗しました' },
  bgm: { path: '/api/install-bgm', failMessage: 'BGM機能の導入に失敗しました' },
  shape: { path: '/api/install-shape', failMessage: '図形機能の導入に失敗しました' },
  transition: { path: '/api/install-transition', failMessage: 'シーン転換機能の導入に失敗しました' },
  speed: { path: '/api/install-speed', failMessage: 'メイン動画速度の導入に失敗しました' },
  mainLayout: { path: '/api/install-main-layout', failMessage: 'メイン動画レイアウトの導入に失敗しました' },
};

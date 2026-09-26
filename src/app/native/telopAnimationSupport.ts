// 判定の本体は core にある（apply-text-style-all が同じ規則を使うため。I-3）。
// 画面側はここから再輸出したものを読む。
export { assetAnimationSupport, supportsAnimation, telopClipsLosingAnimation, textAnimationSupport,
  type AnimationSupport } from '../../core/sequence/telopAnimationSupport';

/** 一覧で非対応のカードの下に常時出す 1 行。title 属性だけに置かない。 */
export const UNSUPPORTED_ANIMATION_REASON = 'このスタイルの部品はこの動きに対応していません。';

/**
 * 同梱パックの現行版。`src/server/telopPack/identity.ts` の `BUILTIN_TELOP_PACK_VERSION` が正本だが、
 * その先は `node:crypto` を import しておりブラウザ束ねに含めると壊れる（`re-loop`
 * 監査が「再生」ボタンを見つけられず timeout する）。ここは表示専用の写しとして持つ —
 * 版を上げたら両方を更新する（`identity.test.ts` 側は正本を検証する）。
 */
export const CURRENT_BUILTIN_TELOP_PACK_VERSION = '1.1.0';

/** 旧版のパックを使っている案件で、動きを選んでも効かないことを伝える 1 行（工程末尾まで待たせない）。 */
export const STALE_PACK_ANIMATION_NOTICE =
  'この案件のテロップスタイルは古い版です。選んだ動きはこの版では反映されません。スタイルを更新すると動きます。';
/** 自由書式は NativeText が描くので宣言が要らない（裁定 7 の告知と同じ文言）。 */
export const FREE_TEXT_ANIMATION_NOTICE = '自由書式の字幕は従来どおり全 17 種が動きます。';

// <<< 共有式ここから
/**
 * 既存 9 種のアニメーション式。正本は `project-template/src/テロップテンプレート/Telop.tsx:474-521`
 * と `telopStyles.ts:14,28,42,56,70,84,98,112,126`。ここへ抽出し、案件テンプレートと
 * 同梱テロップパックが**1 バイトの写し**を持つ（新 8 種の `telopAnimation.ts` と同じ方式）。
 *
 * この領域は import を 1 本も持たない。`spring` / `interpolate` は引数で受ける
 * （パックの写しは案件へコピーされて動くので、リポジトリの `src/` を import できない）。
 *
 * **丸めない**（新 8 種の `round6` を持ち込まない）。この 9 種は既存の描画を 1 バイトも変えずに
 * 抽出することが要件で（設計 §4.2）、`telopExistingAnimations.test.ts` の 864 ケースのうち 630 件が
 * 小数 7 桁以上の値を HTML に持つ。丸めるとその一致が壊れる。
 */
export type LegacyTelopAnimationId =
  | 'none' | 'slideIn' | 'fadeOnly' | 'slideFromLeft' | 'fadeBlurFromBottom'
  | 'slideLeftFadeBlur' | 'fadeFromRight' | 'fadeFromLeft' | 'charByChar';

/** `telopStyles.ts` の `TelopAnimation` のうち、描画に効く 5 フィールドだけ（`name` は描かない）。 */
export interface LegacyTelopAnimationConfig {
  fadeInDuration: number;
  fadeOutDuration: number;
  slideInDistance: number;
  slideDirection: 'up' | 'down' | 'left' | 'right';
  spring: { damping: number; stiffness: number; mass: number };
  /** charByChar の 1 文字あたり遅延。式そのものはスタイル側が持つのでここでは保持だけ。 */
  charDelay?: number;
}

/** `telopStyles.ts:14,28,42,56,70,84,98,112,126` と 1 対 1。値の写し違いは parity テストが止める。 */
export const LEGACY_TELOP_ANIMATION_CONFIG: Record<LegacyTelopAnimationId, LegacyTelopAnimationConfig> = {
  none:               { fadeInDuration: 0,  fadeOutDuration: 0,  slideInDistance: 0,  slideDirection: 'up',    spring: { damping: 20, stiffness: 100, mass: 0.5 } },
  slideIn:            { fadeInDuration: 8,  fadeOutDuration: 8,  slideInDistance: 30, slideDirection: 'up',    spring: { damping: 20, stiffness: 100, mass: 0.5 } },
  fadeOnly:           { fadeInDuration: 8,  fadeOutDuration: 8,  slideInDistance: 0,  slideDirection: 'up',    spring: { damping: 20, stiffness: 100, mass: 0.5 } },
  slideFromLeft:      { fadeInDuration: 8,  fadeOutDuration: 8,  slideInDistance: 50, slideDirection: 'left',  spring: { damping: 20, stiffness: 100, mass: 0.5 } },
  fadeBlurFromBottom: { fadeInDuration: 10, fadeOutDuration: 10, slideInDistance: 30, slideDirection: 'up',    spring: { damping: 15, stiffness: 120, mass: 0.5 } },
  slideLeftFadeBlur:  { fadeInDuration: 10, fadeOutDuration: 10, slideInDistance: 50, slideDirection: 'left',  spring: { damping: 15, stiffness: 120, mass: 0.5 } },
  fadeFromRight:      { fadeInDuration: 10, fadeOutDuration: 10, slideInDistance: 40, slideDirection: 'right', spring: { damping: 18, stiffness: 100, mass: 0.5 } },
  fadeFromLeft:       { fadeInDuration: 10, fadeOutDuration: 10, slideInDistance: 40, slideDirection: 'left',  spring: { damping: 18, stiffness: 100, mass: 0.5 } },
  charByChar:         { fadeInDuration: 0,  fadeOutDuration: 8,  slideInDistance: 25, slideDirection: 'down',  spring: { damping: 15, stiffness: 200, mass: 0.4 }, charDelay: 2 },
};

/** 同梱パックが当てる 7 種。`none`・未指定は no-op（スタイル自前の短いフェードは残る）、
 *  `charByChar` は字形配置なのでスタイル側の実装に任せる（設計 §3.2）。 */
export const PACK_LEGACY_TELOP_ANIMATION_IDS: readonly LegacyTelopAnimationId[] =
  ['slideIn', 'slideFromLeft', 'fadeBlurFromBottom', 'slideLeftFadeBlur', 'fadeFromRight', 'fadeFromLeft', 'fadeOnly'];

/**
 * 入場窓の床（製品オーナー裁定 6）。素の積では実効 opacity が 12.5〜37.5% まで落ちる
 * （k=1 で 0.333 × 0.125 = 0.042）。入場窓にかぎり共通部分の opacity を 0.5 で下支えすると、
 * 実効はスタイル単独の 50% を下回らなくなる（`eff = max(w, .5) * s >= .5 * s`）。
 * 退場側には張らない（8〜10 フレームの退場が 3 フレームへ切り詰められて 9 種の性格が消えるため）。
 */
export const LEGACY_TELOP_ENTRY_OPACITY_FLOOR = 0.5;

/** `getVariedAnimation`（`project-template/.../Telop.tsx:273-284`）の写し。右からの動きは除外されている。 */
const VARIED_FADE_ONLY: readonly LegacyTelopAnimationId[] =
  ['fadeOnly', 'fadeFromLeft', 'fadeOnly', 'slideFromLeft', 'fadeOnly', 'slideLeftFadeBlur'];

/** `spring` / `interpolate` の注入口。remotion / @harness/frame-runtime のどちらでも同じ形。 */
export interface LegacyTelopAnimationDeps {
  fps: number;
  interpolate: (input: number, inputRange: readonly number[], outputRange: readonly number[],
    options?: { extrapolateLeft?: 'clamp' | 'extend'; extrapolateRight?: 'clamp' | 'extend' }) => number;
  spring: (options: { frame: number; fps: number; config: { damping: number; stiffness: number; mass: number } }) => number;
}

export interface LegacyTelopAnimationFrame { opacity: number; translateX: number; translateY: number }

/**
 * `getAnimationConfig`（同 :288-316）の既存 9 種ぶん。新 8 種・未指定・未知は null を返し、
 * 呼び出し側が自分の既定へ落とす（案件テンプレートの既定は `slideLeftFadeBlur`、パックは no-op）。
 * `segmentId` を渡したときだけ `fadeOnly` が id%6 でばらける。**パックは渡さない**＝純粋なフェード（裁定 1）。
 */
export function resolveLegacyTelopAnimation(
  animation: string | undefined,
  segmentId?: number,
): LegacyTelopAnimationId | null {
  if (animation === 'slideIn') return 'slideIn';
  if (animation === 'fadeOnly')
    return segmentId === undefined ? 'fadeOnly' : VARIED_FADE_ONLY[segmentId % VARIED_FADE_ONLY.length]!;
  if (animation === 'slideFromLeft') return 'slideFromLeft';
  if (animation === 'fadeBlurFromBottom') return 'fadeBlurFromBottom';
  if (animation === 'slideLeftFadeBlur') return 'slideLeftFadeBlur';
  if (animation === 'fadeFromRight') return 'fadeFromRight';
  if (animation === 'fadeFromLeft') return 'fadeFromLeft';
  if (animation === 'charByChar') return 'charByChar';
  if (animation === 'none') return 'none';
  return null;
}

/**
 * `project-template/.../Telop.tsx:474-521` の算式そのもの。**床は張らない**
 * （案件テンプレートの描画を 1 バイトも変えないため。床はパック入口だけが持つ）。
 */
export function legacyTelopAnimationFrame(
  config: LegacyTelopAnimationConfig,
  input: { localFrame: number; durationFrames: number },
  deps: LegacyTelopAnimationDeps,
): LegacyTelopAnimationFrame {
  const { localFrame, durationFrames: duration } = input;
  const hasAnimation = config.fadeInDuration > 0 || config.fadeOutDuration > 0;
  const fadeIn = Math.min(config.fadeInDuration, duration / 3);
  const fadeOut = Math.min(config.fadeOutDuration, duration / 3);
  const opacity = hasAnimation
    ? deps.interpolate(
        localFrame,
        [0, Math.max(1, fadeIn), duration - Math.max(1, fadeOut), duration],
        [0, 1, 1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      )
    : 1;
  const slideIn = config.slideInDistance > 0
    ? deps.spring({ frame: localFrame, fps: deps.fps, config: config.spring })
    : 1;
  const slideDirection = config.slideDirection || 'up';
  let translateX = 0;
  let translateY = 0;
  if (config.slideInDistance > 0) {
    const slideValue = deps.interpolate(slideIn, [0, 1], [config.slideInDistance, 0]);
    switch (slideDirection) {
      case 'left': translateX = -slideValue; break;
      case 'right': translateX = slideValue; break;
      case 'up': translateY = slideValue; break;
      case 'down': translateY = -slideValue; break;
    }
  }
  return { opacity, translateX, translateY };
}

/**
 * 同梱パックの入口。7 種以外（`none`・`charByChar`・未指定・新 8 種・未知）と区間外は **null**
 * ＝現行の描画を 1 バイトも変えない（接続ゲートの no-op 集合がこれを機械で確かめる）。
 *
 * **床の非対称（本件で最重要の設計判断）**: `legacyTelopAnimationFrame` は床を張らず、この関数だけが
 * 張る。案件テンプレートは今日と 1 バイトも描画を変えてはいけない（864 ケースの一致が要件）のに対し、
 * パックは 35 スタイル自前のフェードと掛け算になるため、素の積では実効 opacity が 12.5〜37.5% まで
 * 落ちる（裁定 6）。**どちらに床を張るかで意味が逆になる**ので、読み手が
 * `LEGACY_TELOP_ENTRY_OPACITY_FLOOR` の定義と入口の 2 か所を突き合わせなくても分かるよう両方に書く。
 *
 * 区間外を null にするのは、`localFrame < 0` で opacity 0 の空箱が増えるのを避けるため
 * （スタイル自身は区間外で null を返すので、箱だけが残ると DOM が変わる）。
 */
export function packLegacyTelopAnimationFrame(
  input: { animation: string | undefined; localFrame: number; durationFrames: number },
  deps: LegacyTelopAnimationDeps,
): LegacyTelopAnimationFrame | null {
  const id = resolveLegacyTelopAnimation(input.animation);
  if (id === null || !PACK_LEGACY_TELOP_ANIMATION_IDS.includes(id)) return null;
  if (input.localFrame < 0 || input.localFrame > input.durationFrames) return null;
  // 尺 3 未満は no-op（Codex P1）。`max(1, fadeIn)` と `duration - max(1, fadeOut)` が duration<3 で逆転し、
  // `interpolate` の inputRange が非単調になって例外を投げる（尺 1 なら `[0,1,0,1]`、尺 2 なら `[0,1,1,2]`）。
  if (input.durationFrames < 3) return null;
  const config = LEGACY_TELOP_ANIMATION_CONFIG[id];
  const frame = legacyTelopAnimationFrame(config, input, deps);
  // 入場窓 = この動き自身の fadeIn（`max(1, min(fadeInDuration, duration/3))`）。
  // 35 スタイル自前のフェードはすべてこれより短いことを Task 7 の「入場窓の実測」が検算する。
  const entryFrames = Math.max(1, Math.min(config.fadeInDuration, input.durationFrames / 3));
  const opacity = input.localFrame <= entryFrames
    ? Math.max(frame.opacity, LEGACY_TELOP_ENTRY_OPACITY_FLOOR)
    : frame.opacity;
  return { opacity, translateX: frame.translateX, translateY: frame.translateY };
}
// >>> 共有式ここまで

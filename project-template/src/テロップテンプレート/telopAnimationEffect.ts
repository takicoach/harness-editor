/**
 * リポジトリ src/core/telopAnimation.ts の共有式の写し。案件テンプレートは凍結されて案件へ
 * 配られるためリポジトリの src/ を import できない。ずれは src/server/telopAnimationSource.test.ts
 * （1 バイト一致）と src/server/telopAnimationParity.test.ts（全点の数値一致）が止める。
 * この 2 本を外して式だけ直さないこと。
 */

// <<< 共有式ここから
/** 17 値。`src/core/types.ts` の `TelopAnimation` はこの別名（再定義しない）。 */
export type TelopAnimationId =
  | 'none' | 'slideIn' | 'fadeOnly' | 'slideFromLeft' | 'fadeBlurFromBottom'
  | 'slideLeftFadeBlur' | 'fadeFromRight' | 'fadeFromLeft' | 'charByChar'
  | 'popIn' | 'wipeReveal' | 'typeCursor' | 'underlineGrow' | 'bandLeadsText'
  | 'jumpPop' | 'stampPress' | 'blurOutFocus';

export const BUILTIN_TELOP_ANIMATION_IDS = ['none','slideIn','fadeOnly','slideFromLeft','fadeBlurFromBottom','slideLeftFadeBlur','fadeFromRight','fadeFromLeft','charByChar'] as const satisfies readonly TelopAnimationId[];
export const NEW_TELOP_ANIMATION_IDS = ['popIn','wipeReveal','typeCursor','underlineGrow','bandLeadsText','jumpPop','stampPress','blurOutFocus'] as const satisfies readonly TelopAnimationId[];
export const TELOP_ANIMATION_IDS = [...BUILTIN_TELOP_ANIMATION_IDS, ...NEW_TELOP_ANIMATION_IDS] as const;
export type NewTelopAnimationId = (typeof NEW_TELOP_ANIMATION_IDS)[number];
type AssertNever<T extends never> = T;
/** union へ足して一覧へ足し忘れたら tsc が落ちる（逆向きは `satisfies` が止める）。 */
export type NoMissingTelopAnimation = AssertNever<Exclude<TelopAnimationId, (typeof TELOP_ANIMATION_IDS)[number]>>;

/**
 * 動きを 1 フレームぶん計算するための入力。`localFrame` だけに依存し、CSS の
 * `animation`／`transition`／`Date.now()` は使わない（書き出しの決定性）。
 */
export interface TelopEffectInput {
  id: TelopAnimationId;
  localFrame: number;
  durationFrames: number;
  fps: number;
  fontSizePx: number;
  charCount: number;
}

/** 1 フレームぶんの描画指示。未指定のキーは「その属性に触らない」。 */
export interface TelopEffectOutput {
  transform?: string;
  opacity?: number;
  filter?: string;
  clipPath?: string;
  /** typeCursor が出す表示文字数（書記素単位）。 */
  visibleChars?: number;
  /** typeCursor のカーソル表示。出切ったら false。 */
  cursor?: boolean;
  /** underlineGrow の下線の伸び（0..1）。 */
  underline?: number;
  /** bandLeadsText の帯の伸び（0..1）。 */
  band?: number;
}

/** 入場フレーム数。規定値・尺の半分・最低 1 フレームで頭打ち（既存 `Telop.tsx` と同じ流儀）。 */
export function telopEnterFrames(regularFrames: number, durationFrames: number): number {
  return Math.max(1, Math.min(regularFrames, Math.floor(durationFrames / 2)));
}

/** 退場フレーム数。規定値と尺の三分の一で頭打ち。尺が足りなければ 0（退場しない）。 */
export function telopExitFrames(regularFrames: number, durationFrames: number): number {
  return Math.min(regularFrames, Math.floor(durationFrames / 3));
}

/**
 * typeCursor の文字送りと点滅の周期。1 文字あたり `fps/15`（30fps で 2fr）を基本にし、
 * 尺の 80% までに出切らないときだけ縮める。点滅周期は `fps/2`（30fps で 15fr）。
 * 1 文字 1 フレームが床。床でも 80% に収まらない長文では床が勝つ（0 にすると何も出ない）。
 */
export function telopTypeCursorPlan(input: {durationFrames: number; fps: number; charCount: number}): {charFrames: number; blinkPeriodFrames: number} {
  const blinkPeriodFrames = Math.max(1, Math.round(input.fps / 2));
  let charFrames = Math.max(1, Math.round(input.fps / 15));
  const budget = input.durationFrames * 0.8;
  if (input.charCount > 0 && input.charCount * charFrames > budget)
    charFrames = Math.max(1, Math.floor(budget / input.charCount));
  return {charFrames, blinkPeriodFrames};
}

/** 打ち込み中に出すカーソル。 */
export const TELOP_TYPE_CURSOR = '|';

export function isNewTelopAnimation(id: string | undefined): id is NewTelopAnimationId {
  return id !== undefined && (NEW_TELOP_ANIMATION_IDS as readonly string[]).includes(id);
}

/** 小数 6 桁へ丸める。プレビュー＝書き出し・core＝写しを文字列一致で比較できるようにする。 */
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 30fps 基準のフレーム数を実 fps へ（= Math.round(秒 * fps)、秒 = frames30 / 30）。 */
export function telopScaleFrames(frames30: number, fps: number): number {
  return Math.max(1, Math.round((frames30 / 30) * fps));
}

/** cubic-bezier(.25,.1,.25,1)（CSS の ease）を Newton 法で解く。 */
const ease = (x: number): number => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const x1 = .25, y1 = .1, x2 = .25, y2 = 1;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  let t = x;
  for (let index = 0; index < 12; index++) {
    const value = ((ax * t + bx) * t + cx) * t - x;
    if (Math.abs(value) < 1e-12) break;
    const slope = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(slope) < 1e-12) break;
    t -= value / slope;
  }
  t = clamp01(t);
  return ((ay * t + by) * t + cy) * t;
};

/** 区間ごとに ease をかける折れ線。stops は昇順で 0 から 1 まで。 */
const piecewise = (progress: number, stops: readonly number[], values: readonly number[]): number => {
  for (let index = 0; index < stops.length - 1; index++) {
    const from = stops[index]!, to = stops[index + 1]!;
    if (progress > to && index < stops.length - 2) continue;
    const span = to - from;
    const local = span <= 0 ? 1 : clamp01((progress - from) / span);
    return values[index]! + (values[index + 1]! - values[index]!) * ease(local);
  }
  return values[values.length - 1]!;
};

/** 書記素分割器。typeCursor はフレームごとに呼ぶ想定なので、呼び出しのたびに new しない。 */
const graphemeSegmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

/** 書記素の数（サロゲートペア・結合絵文字を 1 文字と数える）。 */
export function telopGraphemeCount(text: string): number {
  return Array.from(graphemeSegmenter.segment(text)).length;
}

/** 書記素の単位で先頭 count 文字を返す。 */
export function telopSliceGraphemes(text: string, count: number): string {
  if (count <= 0) return '';
  const parts = Array.from(graphemeSegmenter.segment(text), part => part.segment);
  return parts.slice(0, count).join('');
}

/**
 * 帯の色。CSS.supports はサーバ描画（renderToStaticMarkup）に無く、プレビューと書き出しで
 * 判定が割れるので使わない。空・transparent はカタログの既定色へ落とす。
 */
export function telopBandColor(value: string | undefined): string {
  return value !== undefined && value.trim() !== '' && value !== 'transparent' ? value : '#1e3a8a';
}

/** 退場（新 8 種はこれだけ）。規定は 8 フレーム（30fps 基準）で、尺の 1/3 を超えない。 */
export function telopExitOpacity(localFrame: number, durationFrames: number, fadeOutFrames30: number, fps: number): number {
  const fade = telopExitFrames(telopScaleFrames(fadeOutFrames30, fps), durationFrames);
  if (fade <= 0) return 1;   // 尺が足りず退場フレームが無い（= 退場しない）
  return round6(clamp01((durationFrames - localFrame) / fade));
}

/** 入場の規定フレーム数（30fps 基準）。typeCursor は文字数依存なので持たない。 */
const ENTER_FRAMES_30: Record<NewTelopAnimationId, number> = {
  popIn: 18, wipeReveal: 16, typeCursor: 0, underlineGrow: 16,
  bandLeadsText: 17, jumpPop: 24, stampPress: 14, blurOutFocus: 14,
};

export type TelopEffect = (input: TelopEffectInput) => TelopEffectOutput | null;

export function telopAnimationEffect(input: TelopEffectInput): TelopEffectOutput | null {
  const { id, fps, durationFrames, fontSizePx, charCount } = input;
  if (!isNewTelopAnimation(id)) return null;
  const localFrame = Math.max(0, input.localFrame);

  if (id === 'typeCursor') {
    const { charFrames, blinkPeriodFrames: blink } = telopTypeCursorPlan({ durationFrames, fps, charCount });
    const visibleChars = Math.min(charCount, Math.floor(localFrame / charFrames));
    return { opacity: 1, visibleChars, cursor: visibleChars < charCount && Math.floor(localFrame / blink) % 2 === 0 };
  }

  if (id === 'bandLeadsText') {
    // 帯 9fr → 文字 8fr（30fps 基準の 17fr）。短尺では合計を縮めて 9:8 で割り直す。
    const total = telopEnterFrames(telopScaleFrames(ENTER_FRAMES_30.bandLeadsText, fps), durationFrames);
    const bandFrames = Math.max(1, Math.round((total * 9) / 17));
    const textFrames = Math.max(1, total - bandFrames);
    return {
      band: round6(ease(clamp01(localFrame / bandFrames))),
      opacity: round6(ease(clamp01((localFrame - bandFrames) / textFrames))),
    };
  }

  const span = telopEnterFrames(telopScaleFrames(ENTER_FRAMES_30[id], fps), durationFrames);
  const progress = clamp01(localFrame / span), t = ease(progress);

  if (id === 'popIn') return {
    transform: `scale(${round6(piecewise(progress, [0, .6, .8, 1], [.3, 1.15, .95, 1]))})`,
    opacity: round6(piecewise(progress, [0, .6, 1], [0, 1, 1])),
  };
  if (id === 'wipeReveal') {
    const q = Math.floor(progress * 20) / 20;   // カタログの steps(20)
    return { clipPath: `inset(0 ${round6((1 - q) * 100)}% 0 0)`, opacity: 1 };
  }
  if (id === 'underlineGrow') return { underline: round6(t), opacity: 1 };
  if (id === 'jumpPop') return {
    transform: `translateY(${round6(piecewise(progress, [0, .30, .50, .65, .80, 1], [0, -.5, 0, -.21, 0, 0]) * fontSizePx)}px)`,
    opacity: 1,
  };
  if (id === 'stampPress') return {
    transform: `scale(${round6(piecewise(progress, [0, .6, 1], [2.2, .9, 1]))}) rotate(-8deg)`,
    opacity: round6(piecewise(progress, [0, .6, 1], [0, 1, 1])),
  };
  return { filter: `blur(${round6((1 - t) * fontSizePx * .25)}px)`, opacity: round6(t) };  // blurOutFocus
}
// >>> 共有式ここまで

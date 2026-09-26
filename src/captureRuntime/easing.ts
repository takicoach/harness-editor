/**
 * captureRuntime: Easing（'remotion' の Easing と同名 export・同値）
 *
 * 移植元: remotion@4.0.489 `node_modules/remotion/dist/cjs/easing.js`
 * （Remotion 側はさらに react-native の Easing を出自とする）。
 * 逐語コピーはせず、実使用形のみを式として再実装している。
 *
 * 実使用形は `Easing.out(Easing.cubic)` の1形のみ（M2a Task2 Step1 の機械抽出:
 * `git grep -oE "Easing\.[a-zA-Z]+"` → cubic 41 / out 41・他0）。
 * それ以外（bezier/spring/bounce/elastic/step0/…）は未実装。TS 型に存在しないため
 * コンパイル時に落ちるが、JS からの呼び出しでも黙って違う値を返さないよう
 * ランタイムでも throw する。
 */

export type EasingFunction = (input: number) => number;

const unimplemented = (name: string): never => {
  throw new Error(
    `captureRuntime: 未実装オプション Easing.${name}（実使用は Easing.out(Easing.cubic) のみ）`,
  );
};

export const Easing = {
  /** t^3 */
  cubic(t: number): number {
    return t * t * t;
  },

  /** easing を「終端が緩む」向きへ反転する */
  out(easing: EasingFunction): EasingFunction {
    return (t: number) => 1 - easing(1 - t);
  },

  // --- 以下は実使用0件のため未実装（黙って違う値を返さないための明示 throw）---
  in: (_easing: EasingFunction): EasingFunction => unimplemented('in'),
  inOut: (_easing: EasingFunction): EasingFunction => unimplemented('inOut'),
  linear: (_t: number): number => unimplemented('linear'),
  ease: (_t: number): number => unimplemented('ease'),
  quad: (_t: number): number => unimplemented('quad'),
  sin: (_t: number): number => unimplemented('sin'),
  circle: (_t: number): number => unimplemented('circle'),
  exp: (_t: number): number => unimplemented('exp'),
  bounce: (_t: number): number => unimplemented('bounce'),
  poly: (_n: number): EasingFunction => unimplemented('poly'),
  elastic: (_bounciness?: number): EasingFunction => unimplemented('elastic'),
  back: (_s?: number): EasingFunction => unimplemented('back'),
  bezier: (_x1: number, _y1: number, _x2: number, _y2: number): EasingFunction =>
    unimplemented('bezier'),
  step0: (_n: number): number => unimplemented('step0'),
  step1: (_n: number): number => unimplemented('step1'),
  spring: (_options?: unknown): EasingFunction => unimplemented('spring'),
} as const;

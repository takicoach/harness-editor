/**
 * チュートリアル進行の純関数。DOM / React に触れない（unit テスト対象）。
 * ステップ定義は tutorialSteps.ts、フックは useTutorial.ts。
 */
import type { TutorialCtx, TutorialSnapshot, TutorialStep } from './tutorialSteps';

/** ステップが現在の状態で表示可能か。 */
export function isApplicable(step: TutorialStep, ctx: TutorialCtx): boolean {
  return step.when === undefined || step.when(ctx);
}

/**
 * from 以降で最初に表示可能なステップの添字を返す。無ければ steps.length。
 * （末尾 finish は when 無し＝常に表示可能なので、通常は必ずどこかに着地する）
 */
export function firstApplicable(steps: TutorialStep[], from: number, ctx: TutorialCtx): number {
  for (let i = Math.max(0, from); i < steps.length; i++) {
    const step = steps[i];
    if (step !== undefined && isApplicable(step, ctx)) return i;
  }
  return steps.length;
}

/** ステップ入場時に控える基準値。 */
export function takeSnapshot(ctx: TutorialCtx): TutorialSnapshot {
  return { telopCount: ctx.telopCount, dirty: ctx.dirty };
}

/** 実操作の完了を検知して自動前進すべきか。 */
export function shouldAutoAdvance(
  step: TutorialStep,
  ctx: TutorialCtx,
  snapshot: TutorialSnapshot,
): boolean {
  return step.advanceWhen !== undefined && step.advanceWhen(ctx, snapshot);
}

/** 照準セレクタを解決する（null = 画面中央）。 */
export function resolveTarget(step: TutorialStep, ctx: TutorialCtx): string | null {
  return typeof step.target === 'function' ? step.target(ctx) : step.target;
}

/** 本文を解決する。 */
export function resolveText(step: TutorialStep, ctx: TutorialCtx): string {
  return typeof step.text === 'function' ? step.text(ctx) : step.text;
}

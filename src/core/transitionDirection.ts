import type { SceneTransition, SlideDirection } from './types';

/**
 * Shared native preview/export default for saved slide/wipe transitions without a direction.
 * transitionDirection.test.ts pins this against the immutable original adapter's pure
 * direction branches. The retired external factories are not part of this runtime.
 */
export const DEFAULT_SLIDE_DIRECTION: SlideDirection = 'left';

/** 転換 1 件の実効方向（未指定は `DEFAULT_SLIDE_DIRECTION`）。プレビューと書き出しの共通正本。 */
export function effectiveDirection(t: Pick<SceneTransition, 'direction'>): SlideDirection {
  return t.direction ?? DEFAULT_SLIDE_DIRECTION;
}

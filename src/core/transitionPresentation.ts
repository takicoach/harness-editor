import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';
import { linearTiming, type TransitionTiming } from '@remotion/transitions';
import type { FadeProps } from '@remotion/transitions/fade';
import type { SlideProps } from '@remotion/transitions/slide';
import type { WipeProps } from '@remotion/transitions/wipe';
import type { TransitionPresentation } from '@remotion/transitions';
import type { SceneTransitionKind, SlideDirection } from './types';

/** SlideDirection → @remotion/transitions の direction（次の場面がどこから入るか）。 */
function mapSlideDirection(direction: SlideDirection | undefined): SlideProps['direction'] {
  switch (direction) {
    case 'right': return 'from-left';
    case 'up': return 'from-bottom';
    case 'down': return 'from-top';
    case 'left':
    default: return 'from-right';
  }
}

/** SlideDirection → @remotion/transitions の wipe direction。 */
function mapWipeDirection(direction: SlideDirection | undefined): WipeProps['direction'] {
  switch (direction) {
    case 'right': return 'from-left';
    case 'up': return 'from-bottom';
    case 'down': return 'from-top';
    case 'left':
    default: return 'from-right';
  }
}

/**
 * kind → TransitionSeries.Transition の presentation。
 * fade 系（fadeBlack/fadeWhite/fadeColor）は null（Transition コンポーネントを挟まず
 * 別途オーバーレイで実装）。crossfade/slide/wipe は @remotion/transitions の presentation を返す。
 */
export function presentationFor(
  kind: SceneTransitionKind,
  direction?: SlideDirection,
): TransitionPresentation<FadeProps> | TransitionPresentation<SlideProps> | TransitionPresentation<WipeProps> | null {
  switch (kind) {
    case 'crossfade': return fade();
    case 'slide': return slide({ direction: mapSlideDirection(direction) });
    case 'wipe': return wipe({ direction: mapWipeDirection(direction) });
    default: return null;
  }
}

/** overlap フレーム数の linear タイミング。TransitionSeries.Transition の timing に渡す。 */
export function timingFor(overlapFrames: number): TransitionTiming {
  return linearTiming({ durationInFrames: overlapFrames });
}

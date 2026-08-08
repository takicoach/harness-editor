import type { Orientation } from '../core/types';

export type OrientationCode = 'v' | 'h' | 'sq';

/** コアの Orientation を design-reference の data-orientation 値へ変換する。 */
export function orientationCode(o: Orientation): OrientationCode {
  if (o === 'landscape') return 'h';
  if (o === 'square') return 'sq';
  return 'v';
}

import type { EditState } from './editState';
import type { DuckingSettings } from '../../core/types';

/** ダッキング設定を差し替える（履歴1件）。 */
export function setDucking(state: EditState, ducking: DuckingSettings): EditState {
  return { ...state, ducking };
}

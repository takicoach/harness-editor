import { play, setEnabled, type SoundName } from '../../lib/vendor/cuelume/index.js';

export type UiSoundKind = 'press' | 'toggle' | 'success';
export interface UiSoundConfig { enabled: boolean; kind: 'soft' | 'standard' }

/** Cuelume の音名（vendor/cuelume/sounds/recipes.js）。控えめは高頻度操作向けの極小音。 */
const NAMES: Record<UiSoundConfig['kind'], Record<UiSoundKind, SoundName>> = {
  soft: { press: 'tick', toggle: 'toggle', success: 'chime' },
  standard: { press: 'press', toggle: 'toggle', success: 'success' },
};

let config: UiSoundConfig = { enabled: false, kind: 'soft' };

/** 設定（Task 14 の prefs.sound）を反映する。既定 OFF で始め、ワークスペースが設定を読んだ時点で切り替わる。 */
export function configureUiSound(next: UiSoundConfig): void {
  config = next;
  setEnabled(next.enabled);
}

/** ユーザー操作のハンドラ内で最初に呼ぶ（iOS の自動再生制限）。OFF なら何もしない。 */
export function uiSound(kind: UiSoundKind): void {
  if (!config.enabled) return;
  try { play(NAMES[config.kind][kind]); } catch { /* AudioContext が無い環境（テスト・古いブラウザ）では黙って無視 */ }
}

/** 動画トラック波形の表示高さ設定。standard = 既存表示、large = 高さ・振幅を拡大。 */
export type WaveformPref = 'standard' | 'large';

const PREFS: readonly WaveformPref[] = ['standard', 'large'];
const KEY = 'sme-waveform-pref';

/** localStorage から波形設定を読む。未設定・不正値は standard。 */
export function loadWaveformPref(): WaveformPref {
  try {
    const v = localStorage.getItem(KEY);
    return PREFS.includes(v as WaveformPref) ? (v as WaveformPref) : 'standard';
  } catch {
    return 'standard';
  }
}

/** 波形設定を localStorage に保存（失敗は無視）。 */
export function saveWaveformPref(v: WaveformPref): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* 失敗は無視 */
  }
}

/** CutTrack（.tl-track-cut）の高さ（px）。既存値 58px を standard として維持。 */
export function waveformTrackHeight(pref: WaveformPref): number {
  return pref === 'large' ? 96 : 58;
}

/** Waveform canvas の高さ（px）。既存値 20px を standard として維持。 */
export function waveformCanvasHeight(pref: WaveformPref): number {
  return pref === 'large' ? 48 : 20;
}

/** 波形バーの振幅倍率。large は視認性のため既定より大きく振らせる。 */
export function waveformGain(pref: WaveformPref): number {
  return pref === 'large' ? 1.6 : 1;
}

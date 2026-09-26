export const MAIN_AUDIO_GAIN_DB_MIN = -60;
export const MAIN_AUDIO_GAIN_DB_MAX = 12;

export interface MainAudioSettings {
  gainDb: number;
  muted: boolean;
  /** カット・速度・転換を反映した完成タイムライン上のフレーム数。 */
  fadeInFrames: number;
  /** カット・速度・転換を反映した完成タイムライン上のフレーム数。 */
  fadeOutFrames: number;
}

export const DEFAULT_MAIN_AUDIO: Readonly<MainAudioSettings> = Object.freeze({
  gainDb: 0,
  muted: false,
  fadeInFrames: 0,
  fadeOutFrames: 0,
});

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} はobjectで指定してください`);
  }
  return value as Record<string, unknown>;
}

function readFiniteNumber(
  value: Record<string, unknown>,
  key: keyof MainAudioSettings,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number {
  if (!hasOwn(value, key)) return fallback;
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`${key} は有限の数値で指定してください`);
  }
  if ((integer && !Number.isSafeInteger(raw)) || raw < min || raw > max) {
    const range = integer ? `${min}以上のsafe integer` : `${min}..${max}`;
    throw new Error(`${key} は${range}で指定してください`);
  }
  return raw;
}

/**
 * API入力・データファイルで共有する厳密な正規化。
 * propertyの省略だけを既定扱いにし、明示された不正値を黙って補正しない。
 */
export function normalizeMainAudioSettings(value: unknown): MainAudioSettings {
  const record = asRecord(value, 'MAIN_AUDIO');
  const muted = hasOwn(record, 'muted') ? record.muted : DEFAULT_MAIN_AUDIO.muted;
  if (typeof muted !== 'boolean') throw new Error('muted はbooleanで指定してください');
  return {
    gainDb: readFiniteNumber(
      record,
      'gainDb',
      DEFAULT_MAIN_AUDIO.gainDb,
      MAIN_AUDIO_GAIN_DB_MIN,
      MAIN_AUDIO_GAIN_DB_MAX,
      false,
    ),
    muted,
    fadeInFrames: readFiniteNumber(
      record,
      'fadeInFrames',
      DEFAULT_MAIN_AUDIO.fadeInFrames,
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    fadeOutFrames: readFiniteNumber(
      record,
      'fadeOutFrames',
      DEFAULT_MAIN_AUDIO.fadeOutFrames,
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
  };
}

export function isDefaultMainAudio(settings: MainAudioSettings | undefined): boolean {
  const value = settings ?? DEFAULT_MAIN_AUDIO;
  return value.gainDb === 0 && value.muted === false && value.fadeInFrames === 0 && value.fadeOutFrames === 0;
}

export function mainAudioSettingsEqual(
  left: MainAudioSettings | undefined,
  right: MainAudioSettings | undefined,
): boolean {
  const a = left ?? DEFAULT_MAIN_AUDIO;
  const b = right ?? DEFAULT_MAIN_AUDIO;
  return a.gainDb === b.gainDb
    && a.muted === b.muted
    && a.fadeInFrames === b.fadeInFrames
    && a.fadeOutFrames === b.fadeOutFrames;
}

/**
 * 完成タイムラインの1フレームに掛ける元音声gain。
 * fade尺は完成尺までに制限し、既存BGMと同じくfadeInはframe/fade、fadeOut最終frameは0。
 * frame/durationが非有限、durationが負/非整数なら計算を続けず例外にする。
 */
export function mainAudioGainFactor(
  settings: MainAudioSettings,
  finalFrame: number,
  finalDurationFrames: number,
): number {
  const value = normalizeMainAudioSettings(settings);
  if (!Number.isFinite(finalFrame)) throw new Error('finalFrame は有限の数値で指定してください');
  if (!Number.isSafeInteger(finalDurationFrames) || finalDurationFrames < 0) {
    throw new Error('finalDurationFrames は非負のsafe integerで指定してください');
  }
  if (value.muted || finalDurationFrames === 0) return 0;
  const frame = Math.min(Math.max(0, finalFrame), finalDurationFrames - 1);
  const lastFrame = finalDurationFrames - 1;
  const fadeInFrames = Math.min(value.fadeInFrames, finalDurationFrames);
  const fadeOutFrames = Math.min(value.fadeOutFrames, finalDurationFrames);
  const fadeIn = fadeInFrames > 0 && frame < fadeInFrames
    ? frame / fadeInFrames
    : 1;
  const fadeOut = fadeOutFrames > 0 && frame > lastFrame - fadeOutFrames
    ? Math.max(0, (lastFrame - frame) / fadeOutFrames)
    : 1;
  return 10 ** (value.gainDb / 20) * Math.min(fadeIn, fadeOut);
}

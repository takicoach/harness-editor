import type { DuckingSettings, DuckingStrength } from '../../core/types';

export const DEFAULT_DUCKING: DuckingSettings = { enabled: true, strength: 'mid' };

const KEY = 'sme-ducking';
const STRENGTHS: readonly DuckingStrength[] = ['weak', 'mid', 'strong'];

/** localStorage からダッキング設定を読む。未設定・不正値は既定。 */
export function loadDuckingSettings(): DuckingSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_DUCKING;
    const v = JSON.parse(raw) as Partial<DuckingSettings>;
    if (typeof v.enabled !== 'boolean' || !STRENGTHS.includes(v.strength as DuckingStrength)) {
      return DEFAULT_DUCKING;
    }
    return { enabled: v.enabled, strength: v.strength as DuckingStrength };
  } catch {
    return DEFAULT_DUCKING;
  }
}

/** ダッキング設定を localStorage に保存（失敗は無視）。 */
export function saveDuckingSettings(v: DuckingSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* 失敗は無視 */
  }
}

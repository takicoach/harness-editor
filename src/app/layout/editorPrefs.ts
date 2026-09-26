/** エディタ設定（UI 添削 F18）。テーマは theme.ts、自動保存は autoSavePref.ts が別に持つ。 */
export interface EditorPrefs {
  density: 'compact' | 'standard';
  reduceMotion: boolean;
  shuttleMax: 4 | 8;
  snapDefault: boolean;
  /** プレビューのセーフエリア枠。既定 ON（設計 G）。 */
  safeArea: boolean;
  sound: { enabled: boolean; kind: 'soft' | 'standard' };
}

export const DEFAULT_PREFS: EditorPrefs = { density: 'standard', reduceMotion: false, shuttleMax: 8, snapDefault: true, safeArea: true, sound: { enabled: true, kind: 'soft' } };

const KEY = 'sme-editor-prefs';

/** 項目ごとに検証し、壊れた項目だけ既定へ戻す（全体を捨てない）。 */
export function normalizePrefs(value: unknown): EditorPrefs {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const sound = (v['sound'] && typeof v['sound'] === 'object' ? v['sound'] : {}) as Record<string, unknown>;
  return {
    density: v['density'] === 'compact' ? 'compact' : 'standard',
    reduceMotion: v['reduceMotion'] === true,
    shuttleMax: v['shuttleMax'] === 4 ? 4 : 8,
    snapDefault: v['snapDefault'] !== false,
    safeArea: v['safeArea'] !== false,
    sound: { enabled: sound['enabled'] !== false, kind: sound['kind'] === 'standard' ? 'standard' : 'soft' },
  };
}

export function loadEditorPrefs(): EditorPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalizePrefs(JSON.parse(raw)) : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveEditorPrefs(prefs: EditorPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode 等。保存できなくても設定自体は効かせる */ }
}

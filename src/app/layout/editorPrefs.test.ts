/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, loadEditorPrefs, normalizePrefs, saveEditorPrefs } from './editorPrefs';

afterEach(() => localStorage.clear());

describe('editorPrefs', () => {
  it('未保存なら既定（標準密度・音 ON・控えめ・最高 8 倍・スナップ ON）', () => {
    expect(loadEditorPrefs()).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toEqual({ density: 'standard', reduceMotion: false, shuttleMax: 8, snapDefault: true, safeArea: true, sound: { enabled: true, kind: 'soft' } });
  });
  it('保存して読み戻せる', () => {
    saveEditorPrefs({ ...DEFAULT_PREFS, density: 'compact', shuttleMax: 4, sound: { enabled: false, kind: 'standard' } });
    expect(loadEditorPrefs()).toMatchObject({ density: 'compact', shuttleMax: 4, sound: { enabled: false, kind: 'standard' } });
  });
  it('壊れた値は項目ごとに既定へ戻す', () => {
    localStorage.setItem('sme-editor-prefs', '{"density":"huge","shuttleMax":16,"sound":{"enabled":"yes"},"reduceMotion":true}');
    expect(loadEditorPrefs()).toEqual({ ...DEFAULT_PREFS, reduceMotion: true });
    localStorage.setItem('sme-editor-prefs', 'not json');
    expect(loadEditorPrefs()).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
  });
  it('safeArea の既定は ON で、壊れた値だけ既定へ戻す', () => {
    expect(DEFAULT_PREFS.safeArea).toBe(true);
    expect(normalizePrefs({}).safeArea).toBe(true);
    expect(normalizePrefs({ safeArea: false }).safeArea).toBe(false);
    expect(normalizePrefs({ safeArea: 'no' }).safeArea).toBe(true);
    expect(normalizePrefs({ safeArea: false, density: 'broken' })).toMatchObject({ safeArea: false, density: 'standard' });
  });
});

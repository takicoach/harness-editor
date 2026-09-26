/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_TUTORIAL_DONE_KEY, NATIVE_TUTORIAL_RESUME_KEY, clearNativeTutorialResume, isNativeTutorialDone,
  markNativeTutorialDone, saveNativeTutorialResume, takeNativeTutorialResume, type TutorialStorage,
} from './nativeTutorialStorage';

const VALID = ['modes', 'save'];

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('完了の記録（新キー）', () => {
  it('未完了 → 記録すると完了', () => {
    expect(isNativeTutorialDone()).toBe(false);
    markNativeTutorialDone();
    expect(localStorage.getItem(NATIVE_TUTORIAL_DONE_KEY)).not.toBeNull();
    expect(isNativeTutorialDone()).toBe(true);
  });
  it('旧キー sme-tutorial-done だけでは完了扱いにしない（OSS 0.3 で見た人にも1回出す）', () => {
    localStorage.setItem('sme-tutorial-done', '2026-07-10T00:00:00.000Z');
    expect(NATIVE_TUTORIAL_DONE_KEY).not.toBe('sme-tutorial-done');
    expect(isNativeTutorialDone()).toBe(false);
  });
  it('保存先が無い・読めないときは「完了扱い」にして自動で出さない', () => {
    expect(isNativeTutorialDone(null)).toBe(true);
    const getItem = vi.fn(() => { throw new Error('denied'); });
    const denied: TutorialStorage = { getItem, setItem: vi.fn(), removeItem: vi.fn() };
    expect(isNativeTutorialDone(denied)).toBe(true);
    expect(getItem).toHaveBeenCalledWith(NATIVE_TUTORIAL_DONE_KEY);
  });
  it('実際の localStorage が拒否されても完了扱い（拒否が本当に起きたことも確かめる）', () => {
    // testSetup.ts が localStorage と global Storage を同じ実装に揃えている前提。崩れたらこの検査は空振りになる。
    expect(Object.getPrototypeOf(localStorage)).toBe(Storage.prototype);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(isNativeTutorialDone()).toBe(true);
    expect(spy).toHaveBeenCalledWith(NATIVE_TUTORIAL_DONE_KEY);
  });
  it('書き込みが拒否されても例外を出さない', () => {
    const setItem = vi.fn(() => { throw new Error('denied'); });
    expect(() => markNativeTutorialDone({ getItem: vi.fn(), setItem, removeItem: vi.fn() })).not.toThrow();
    expect(setItem).toHaveBeenCalled();
  });
});

describe('ページをまたぐ再開', () => {
  it('同じ作品・既知の手順なら手順 ID を返し、取り出したら消す', () => {
    expect(saveNativeTutorialResume({ projectId: 'p1', stepId: 'modes' })).toBe(true);
    expect(takeNativeTutorialResume('p1', VALID)).toBe('modes');
    expect(sessionStorage.getItem(NATIVE_TUTORIAL_RESUME_KEY)).toBeNull();
  });
  it('別の作品では null を返して消す', () => {
    saveNativeTutorialResume({ projectId: 'p1', stepId: 'modes' });
    expect(takeNativeTutorialResume('p2', VALID)).toBeNull();
    expect(sessionStorage.getItem(NATIVE_TUTORIAL_RESUME_KEY)).toBeNull();
  });
  it.each([
    ['壊れた JSON', '{'],
    ['未知の手順', JSON.stringify({ projectId: 'p1', stepId: 'no-such-step' })],
    ['空の作品 ID', JSON.stringify({ projectId: '', stepId: 'modes' })],
    ['型違い', JSON.stringify({ projectId: 1, stepId: 'modes' })],
    ['配列', JSON.stringify(['p1', 'modes'])],
  ])('%s は null を返して消す', (_label, raw) => {
    sessionStorage.setItem(NATIVE_TUTORIAL_RESUME_KEY, raw);
    expect(takeNativeTutorialResume('p1', VALID)).toBeNull();
    expect(sessionStorage.getItem(NATIVE_TUTORIAL_RESUME_KEY)).toBeNull();
  });
  it('保存が無ければ null', () => {
    expect(takeNativeTutorialResume('p1', VALID)).toBeNull();
  });
  it('clear で消える', () => {
    saveNativeTutorialResume({ projectId: 'p1', stepId: 'modes' });
    clearNativeTutorialResume();
    expect(sessionStorage.getItem(NATIVE_TUTORIAL_RESUME_KEY)).toBeNull();
  });
  it('実際の sessionStorage が拒否されても false を返すだけ（拒否が本当に起きたことも確かめる）', () => {
    // sessionStorage は jsdom の実体（testSetup は差し替えない）。Storage.prototype を spy しても効かない。
    const proto = Object.getPrototypeOf(sessionStorage) as Storage;
    expect(proto === Storage.prototype).toBe(false); // toBe で比べると jsdom の prototype を表示しようとして Illegal invocation になる
    const spy = vi.spyOn(proto, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(saveNativeTutorialResume({ projectId: 'p1', stepId: 'modes' })).toBe(false);
    expect(spy).toHaveBeenCalledWith(NATIVE_TUTORIAL_RESUME_KEY, expect.any(String));
  });
});

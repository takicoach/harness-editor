/**
 * @vitest-environment jsdom
 */
/**
 * 新機能の NEW バッジ（確認したら消える）の判定と既読永続化。
 * 「どれが新しいか」は各エントリの addedIn（機能世代タグ）1 箇所から導出し、
 * 既読は localStorage。localStorage が使えない環境でも落ちない（常に NEW 表示でよい）。
 * 既読キーは scope（help / tutorial）で名前空間を分ける — 両者は id を共有するため。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CURRENT_FEATURE_GENERATION,
  featureSeenKey,
  isFeatureSeen,
  isNewGeneration,
  loadSeenFeatures,
  markFeatureSeen,
  showNewBadge,
} from './featureSeen';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('isNewGeneration', () => {
  it('現行世代のタグだけ新機能とみなす', () => {
    expect(isNewGeneration(CURRENT_FEATURE_GENERATION)).toBe(true);
  });
  it('タグ無し・旧世代は新機能ではない', () => {
    expect(isNewGeneration(undefined)).toBe(false);
    expect(isNewGeneration('2000-01')).toBe(false);
  });
});

describe('showNewBadge', () => {
  it('現行世代かつ未読のときだけ出す', () => {
    expect(showNewBadge(CURRENT_FEATURE_GENERATION, 'board', new Set())).toBe(true);
    expect(showNewBadge(CURRENT_FEATURE_GENERATION, 'board', new Set(['other']))).toBe(true);
  });
  it('既読集合に入っていれば出さない', () => {
    expect(showNewBadge(CURRENT_FEATURE_GENERATION, 'board', new Set(['board']))).toBe(false);
  });
  it('旧世代・タグ無しは既読と無関係に出さない', () => {
    expect(showNewBadge(undefined, 'board', new Set())).toBe(false);
    expect(showNewBadge('2000-01', 'board', new Set())).toBe(false);
  });
});

describe('既読キーの名前空間', () => {
  it('scope がキーに入る（図鑑とチュートリアルで別キー）', () => {
    expect(featureSeenKey('help', 'board')).toBe('sme.featureSeen.help.board');
    expect(featureSeenKey('tutorial', 'board')).toBe('sme.featureSeen.tutorial.board');
  });

  it('チュートリアルで見ても図鑑側は未読のまま（逆も同じ）', () => {
    markFeatureSeen('tutorial', 'board');
    expect(isFeatureSeen('tutorial', 'board')).toBe(true);
    expect(isFeatureSeen('help', 'board')).toBe(false);

    markFeatureSeen('help', 'create');
    expect(isFeatureSeen('help', 'create')).toBe(true);
    expect(isFeatureSeen('tutorial', 'create')).toBe(false);
  });

  it('loadSeenFeatures も scope 単位で集める', () => {
    markFeatureSeen('tutorial', 'board');
    expect(loadSeenFeatures('help', ['board', 'create']).size).toBe(0);
    expect(loadSeenFeatures('tutorial', ['board', 'create']).has('board')).toBe(true);
  });
});

describe('既読の永続化', () => {
  it('mark すると isFeatureSeen が true になり、localStorage に世代が残る', () => {
    expect(isFeatureSeen('help', 'board')).toBe(false);
    markFeatureSeen('help', 'board');
    expect(isFeatureSeen('help', 'board')).toBe(true);
    expect(localStorage.getItem(featureSeenKey('help', 'board'))).toBe(CURRENT_FEATURE_GENERATION);
  });

  it('旧世代で既読になった項目は未読へ戻る（addedIn の貼り替えで再 NEW 化できる）', () => {
    localStorage.setItem(featureSeenKey('help', 'board'), '2000-01');
    expect(isFeatureSeen('help', 'board')).toBe(false);
    expect(loadSeenFeatures('help', ['board']).size).toBe(0);
  });

  it('loadSeenFeatures は既読 id の集合を返す', () => {
    markFeatureSeen('help', 'board');
    markFeatureSeen('help', 'trash');
    const seen = loadSeenFeatures('help', ['board', 'create', 'trash']);
    expect(seen.has('board')).toBe(true);
    expect(seen.has('trash')).toBe(true);
    expect(seen.has('create')).toBe(false);
  });

  it('localStorage が使えなくても落ちず、未読（＝NEW 表示）として扱う', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => markFeatureSeen('help', 'board')).not.toThrow();
    expect(isFeatureSeen('help', 'board')).toBe(false);
    expect(loadSeenFeatures('help', ['board']).size).toBe(0);
  });
});

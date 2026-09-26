/**
 * @vitest-environment jsdom
 */
/**
 * jsdom 環境で Web Storage が実際に使えることを固定する回帰テスト。
 * Node 26 の組み込み localStorage（undefined）が jsdom の実体を覆い隠す事故の再発防止。
 * setupFiles（src/testSetup.ts）が外れると、この一式が即座に落ちる。
 */
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  localStorage.clear();
});

describe('jsdom 環境の Web Storage', () => {
  it('localStorage が Storage の実体として存在する', () => {
    expect(localStorage).toBeDefined();
    expect(typeof localStorage.clear).toBe('function');
    expect(typeof localStorage.key).toBe('function');
  });

  it('sessionStorage も存在する', () => {
    expect(sessionStorage).toBeDefined();
    expect(typeof sessionStorage.clear).toBe('function');
  });

  it('書いた値を読み戻せる', () => {
    localStorage.setItem('harness-test-key', 'v1');
    expect(localStorage.getItem('harness-test-key')).toBe('v1');
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe('harness-test-key');
  });

  it('未設定キーは null・remove と clear が効く', () => {
    expect(localStorage.getItem('未設定')).toBeNull();
    localStorage.setItem('a', '1');
    localStorage.removeItem('a');
    expect(localStorage.getItem('a')).toBeNull();
    localStorage.setItem('b', '2');
    localStorage.clear();
    expect(localStorage.length).toBe(0);
  });

  it('値は文字列へ揃えられる（ブラウザ準拠）', () => {
    localStorage.setItem('n', 1 as unknown as string);
    expect(localStorage.getItem('n')).toBe('1');
  });
});

/**
 * @vitest-environment jsdom
 *
 * 画面識別子 writerId（data-safety-5）と、その送信経路の配線を固定する。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWriterId, resetWriterIdForTest } from './writerId';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('getWriterId', () => {
  beforeEach(() => {
    resetWriterIdForTest();
    try {
      sessionStorage.clear();
    } catch {
      // メモリ変数だけで足りる（この実装は保存先を持たない）。
    }
  });

  it('同じ画面では毎回同じ値を返す', () => {
    const a = getWriterId();
    expect(getWriterId()).toBe(a);
    expect(a).not.toBe('');
  });

  it('永続化しない: 値は sessionStorage に書かれない（タブ複製で同一 ID にならない）', () => {
    const a = getWriterId();
    expect(a).not.toBe('');
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const k = sessionStorage.key(i);
      if (k !== null) keys.push(k);
    }
    expect(keys).toEqual([]);
    expect(sessionStorage.getItem('sme.writerId')).toBeNull();
  });

  it('画面を読み込み直せば（モジュール再評価相当）別の値になる', () => {
    const a = getWriterId();
    resetWriterIdForTest();
    expect(getWriterId()).not.toBe(a);
  });
});

describe('writerId の配線', () => {
  it('保存 PUT は X-Harness-Writer ヘッダで writerId を送る', () => {
    const src = readFileSync(join(HERE, 'useEditSession.ts'), 'utf8');
    expect(src).toContain("'X-Harness-Writer': getWriterId()");
  });

  it('SSE 接続 URL は ?w= で writerId を送る', () => {
    const src = readFileSync(join(HERE, 'eventBus.tsx'), 'utf8');
    expect(src).toContain('&w=${encodeURIComponent(getWriterId())}');
  });
});

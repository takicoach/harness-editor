import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractErrorMessage, putJson } from './fetchJson';

describe('extractErrorMessage', () => {
  it('error フィールドを取り出す', () => {
    expect(extractErrorMessage({ error: 'ファイルがありません' })).toBe('ファイルがありません');
  });
  it('error が無ければ既定メッセージ', () => {
    expect(extractErrorMessage({})).toBe('サーバエラーが発生しました');
    expect(extractErrorMessage(null)).toBe('サーバエラーが発生しました');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('putJson', () => {
  it('PUT で JSON ボディを送り、成功レスポンスを返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await putJson<{ ok: boolean }>('/api/project?id=x', { a: 1 });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/project?id=x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
  });

  it('非 2xx はサーバの error メッセージで例外化する', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: '外部で変更されています' }),
    }));
    await expect(putJson('/api/project?id=x', {})).rejects.toThrow('外部で変更されています');
  });
});

/**
 * trashApi の応答検証テスト。200 でも本文が想定形でないことはある
 * （プロキシが差し込んだ HTML・別バージョンのサーバ）。分割代入で undefined を
 * 撒き散らす前に、ここで「解釈できませんでした」として弾く。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  deleteMaterialRequest,
  emptyTrashRequest,
  listTrashRequest,
  restoreTrashRequest,
} from './trashApi';

interface StubCall {
  url: string;
  init?: RequestInit;
}

const calls: StubCall[] = [];

function stubFetch(status: number, body: unknown): void {
  calls.length = 0;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const LIBS = {
  seLibrary: [],
  imageLibrary: [],
  bgmLibrary: [],
  videoLibrary: [],
  assetVersions: {},
};

describe('deleteMaterialRequest の応答検証', () => {
  it('200 でも entry が無ければ例外にする', async () => {
    stubFetch(200, { ...LIBS });
    await expect(deleteMaterialRequest('p', 'se', 'a.mp3', false)).rejects.toThrow(/解釈できません/);
  });

  it('200 でも seLibrary が配列でなければ例外にする', async () => {
    stubFetch(200, { entry: { id: '1' }, ...LIBS, seLibrary: 'x' });
    await expect(deleteMaterialRequest('p', 'se', 'a.mp3', false)).rejects.toThrow(/解釈できません/);
  });

  it('本文が null（JSON でない応答）でも例外にする', async () => {
    stubFetch(200, null);
    await expect(deleteMaterialRequest('p', 'se', 'a.mp3', false)).rejects.toThrow(/解釈できません/);
  });

  it('正常応答は usedCount つきで返す', async () => {
    stubFetch(200, { entry: { id: '1' }, usedCount: 2, ...LIBS });
    const r = await deleteMaterialRequest('p', 'se', 'a.mp3', true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usedCount).toBe(2);
  });
});

describe('listTrashRequest の応答検証', () => {
  it('entries が配列でなければ例外にする', async () => {
    stubFetch(200, { entries: 'x' });
    await expect(listTrashRequest('p')).rejects.toThrow(/解釈できません/);
  });
});

describe('restoreTrashRequest / emptyTrashRequest', () => {
  it('復元応答のライブラリパッチを返す（無ければ null）', async () => {
    stubFetch(200, { restoredPath: 'public/se/a.mp3' });
    const r = await restoreTrashRequest('p', 'e1');
    expect(r.restoredPath).toBe('public/se/a.mp3');
    expect(r.libraries).toBeNull();
  });

  it('restoredPath が無ければ例外にする', async () => {
    stubFetch(200, { ...LIBS });
    await expect(restoreTrashRequest('p', 'e1')).rejects.toThrow(/解釈できません/);
  });

  it('全件削除は all:true を明示して送る（entryId 省略の暗黙契約をやめる）', async () => {
    stubFetch(200, { removed: 2 });
    await emptyTrashRequest('p');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ id: 'p', all: true });
  });

  it('1件削除は entryId だけを送る', async () => {
    stubFetch(200, { removed: 1 });
    await emptyTrashRequest('p', 'e1');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ id: 'p', entryId: 'e1' });
  });

  it('removed が数値でなければ例外にする', async () => {
    stubFetch(200, { removed: 'x' });
    await expect(emptyTrashRequest('p', 'e1')).rejects.toThrow(/解釈できません/);
  });
});

/**
 * 作成 API の URL 組み立て。`preferCopy` は UI のチェックから API まで通って
 * 初めて意味を持つ（引数だけ足して呼び出し面へ配線し忘れると、チェックしても
 * 黙ってリンク化されるという最悪の形の半配線になる）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProjectRequest, defaultProjectName } from './createProjectApi';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockOk() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ id: 'p', imported: { linked: false, reason: 'requested', message: 'コピーして取り込みました' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const FILE = new File(['x'], 'take 1.mp4', { type: 'video/mp4' });

describe('createProjectRequest', () => {
  it('既定（リンク優先）では copy パラメータを付けない', async () => {
    const spy = mockOk();
    await createProjectRequest('proj', FILE);
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('video=take%201.mp4');
    expect(url).not.toContain('copy=');
  });

  it('preferCopy を渡すと copy=1 が付く', async () => {
    const spy = mockOk();
    await createProjectRequest('proj', FILE, true);
    expect(String(spy.mock.calls[0]?.[0])).toContain('copy=1');
  });

  it('取り込み結果（imported）をそのまま返す', async () => {
    mockOk();
    const r = await createProjectRequest('proj', FILE, true);
    expect(r.imported?.message).toBe('コピーして取り込みました');
  });
});

describe('defaultProjectName', () => {
  it('日付とファイル名（拡張子なし）から初期値を作る', () => {
    expect(defaultProjectName('DJI_0688.mp4', new Date(2026, 6, 10))).toBe('2026-07-10-DJI_0688');
  });
});

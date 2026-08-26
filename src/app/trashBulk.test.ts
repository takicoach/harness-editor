import { describe, it, expect, vi } from 'vitest';
import { moveProjectsToTrash, formatBulkTrashResult } from './trashBulk';

const T = (id: string, name = id) => ({ id, name });

describe('moveProjectsToTrash', () => {
  it('全件成功なら moved に並び順どおり入る', async () => {
    const req = vi.fn().mockResolvedValue(undefined);
    const r = await moveProjectsToTrash([T('a'), T('b')], req);
    expect(r.moved).toEqual(['a', 'b']);
    expect(r.skipped).toEqual([]);
    expect(req.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('逐次実行する（同時に 2 本走らせない）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const req = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    await moveProjectsToTrash([T('a'), T('b'), T('c')], req);
    expect(maxInFlight).toBe(1);
  });

  it('失敗した項目はスキップして続行し、理由を残す', async () => {
    const req = vi.fn(async (id: string) => {
      if (id === 'b') throw new Error('処理が実行中です');
    });
    const r = await moveProjectsToTrash([T('a'), T('b', 'ビー'), T('c')], req);
    expect(r.moved).toEqual(['a', 'c']);
    expect(r.skipped).toEqual([{ id: 'b', name: 'ビー', reason: '処理が実行中です' }]);
    // 失敗の後も後続が呼ばれている
    expect(req.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  it('Error でない例外も理由の文言に落とす', async () => {
    const req = vi.fn(async () => {
      throw 'boom';
    });
    const r = await moveProjectsToTrash([T('a')], req);
    expect(r.skipped[0]?.reason).toBe('削除できませんでした');
  });

  it('対象が空なら 1 回も呼ばない', async () => {
    const req = vi.fn().mockResolvedValue(undefined);
    const r = await moveProjectsToTrash([], req);
    expect(req).not.toHaveBeenCalled();
    expect(r).toEqual({ moved: [], skipped: [] });
  });
});

describe('formatBulkTrashResult', () => {
  it('全件成功なら件数だけ', () => {
    expect(formatBulkTrashResult({ moved: ['a', 'b'], skipped: [] })).toBe(
      '2 件をゴミ箱へ移動しました',
    );
  });

  it('スキップがあれば件数と理由を並べる', () => {
    const msg = formatBulkTrashResult({
      moved: ['a'],
      skipped: [{ id: 'b', name: 'ビー', reason: '処理が実行中です' }],
    });
    expect(msg).toContain('1 件をゴミ箱へ移動しました');
    expect(msg).toContain('1 件はスキップしました');
    expect(msg).toContain('ビー: 処理が実行中です');
  });

  it('0 件移動でもスキップ理由は伝える', () => {
    const msg = formatBulkTrashResult({
      moved: [],
      skipped: [{ id: 'b', name: 'ビー', reason: 'だめ' }],
    });
    expect(msg).toContain('0 件');
    expect(msg).toContain('ビー: だめ');
  });
});

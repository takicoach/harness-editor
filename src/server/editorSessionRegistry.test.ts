import { describe, expect, it, vi } from 'vitest';
import { EditorSessionRegistry } from './editorSessionRegistry';

const heartbeat = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'window-a', sessionKey: 'a'.repeat(32), sequence: 1,
  snapshot: { status: 'ready', projectId: 'project-a', revision: 'revision-a', dirty: false,
    saving: false, humanBusy: false,
    elements: [{ id: '1', text: '素振りをする', sourceFrameRange: { start: 0, end: 30 } }] },
  ...overrides,
});

describe('編集画面の接続と現在状態', () => {
  it('別画面を個別に列挙し、一覧へ本文や所有キーを漏らさない', () => {
    const registry = new EditorSessionRegistry(vi.fn(), () => 1000, 100);
    registry.heartbeat(heartbeat());
    registry.heartbeat(heartbeat({ sessionId: 'window-b', sessionKey: 'b'.repeat(32),
      snapshot: { status: 'home', projectId: null } }));
    expect(registry.list()).toEqual([
      { sessionId: 'window-a', status: 'ready', projectId: 'project-a', revision: 'revision-a',
        dirty: false, saving: false, humanBusy: false, elementCount: 1, expiresAt: 1100 },
      { sessionId: 'window-b', status: 'home', projectId: null, revision: null,
        dirty: false, saving: false, humanBusy: false, elementCount: 0, expiresAt: 1100 },
    ]);
    const snapshot = registry.snapshot('window-a');
    if (snapshot.status !== 'ready') throw new Error('ready expected');
    snapshot.elements[0]!.text = '呼出側の変更';
    expect(registry.snapshot('window-a')).toEqual(heartbeat().snapshot);
  });

  it('所有キー違い・古い番号・同じ番号の異なる状態を拒否して元状態を保持する', () => {
    const registry = new EditorSessionRegistry(vi.fn());
    const input = heartbeat(); registry.heartbeat(input);
    expect(() => registry.heartbeat(heartbeat({ sessionKey: 'b'.repeat(32) }))).toThrow(/OWNERSHIP_CONFLICT/);
    expect(() => registry.heartbeat(heartbeat({ sequence: 0 }))).toThrow(/STALE_HEARTBEAT/);
    expect(() => registry.heartbeat(heartbeat({ snapshot: { status: 'loading', projectId: 'project-b' } })))
      .toThrow(/HEARTBEAT_CONFLICT/);
    expect(() => registry.close('window-a', 'b'.repeat(32))).toThrow(/OWNERSHIP_CONFLICT/);
    expect(registry.snapshot('window-a')).toEqual(input.snapshot);
    registry.heartbeat(heartbeat({ sequence: 2, snapshot: { status: 'loading', projectId: 'project-b' } }));
    expect(registry.snapshot('window-a')).toEqual({ status: 'loading', projectId: 'project-b' });
  });

  it('同じ状態の再送は期限だけを延ばし、期限切れを一度だけ通知する', () => {
    let now = 1000; const disconnect = vi.fn();
    const registry = new EditorSessionRegistry(disconnect, () => now, 100);
    registry.heartbeat(heartbeat()); now = 1090;
    registry.heartbeat(heartbeat()); now = 1100;
    expect(registry.list()).toHaveLength(1); now = 1190;
    expect(() => registry.snapshot('window-a')).toThrow(/EDITOR_OFFLINE/);
    expect(registry.list()).toEqual([]);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith('window-a');
  });

  it('切断記録の永続化に失敗したら次の所有者へ進めず、再試行する', () => {
    let now = 1000; let fail = true;
    const disconnect = vi.fn(() => { if (fail) throw new Error('STORE_BUSY'); });
    const registry = new EditorSessionRegistry(disconnect, () => now, 100);
    registry.heartbeat(heartbeat()); now = 1100;
    expect(() => registry.heartbeat(heartbeat({ sessionKey: 'b'.repeat(32) }))).toThrow(/STORE_BUSY/);
    expect(() => registry.list()).toThrow(/STORE_BUSY/);
    fail = false;
    registry.heartbeat(heartbeat({ sessionKey: 'b'.repeat(32), sequence: 2 }));
    registry.authenticate('window-a', 'b'.repeat(32));
    expect(disconnect).toHaveBeenCalledTimes(3);
  });

  it('明示切断でも先に結果不明を記録し、失敗時は既存の所有関係を保つ', () => {
    const disconnect = vi.fn().mockImplementationOnce(() => { throw new Error('DISK_FULL'); });
    const registry = new EditorSessionRegistry(disconnect);
    registry.heartbeat(heartbeat());
    expect(() => registry.close('window-a', 'a'.repeat(32))).toThrow(/DISK_FULL/);
    registry.authenticate('window-a', 'a'.repeat(32));
    registry.close('window-a', 'a'.repeat(32));
    expect(registry.list()).toEqual([]);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('期限切れ後の同じ番号と古い番号では復活せず、新しい番号でだけ再接続する', () => {
    let now = 1000;
    const registry = new EditorSessionRegistry(vi.fn(), () => now, 100);
    registry.heartbeat(heartbeat({ sequence: 5 })); now = 1100;
    expect(() => registry.heartbeat(heartbeat({ sequence: 4 }))).toThrow(/STALE_HEARTBEAT/);
    expect(() => registry.heartbeat(heartbeat({ sequence: 5 }))).toThrow(/STALE_HEARTBEAT/);
    expect(registry.list()).toEqual([]);
    registry.heartbeat(heartbeat({ sequence: 6 }));
    expect(registry.list()).toHaveLength(1);
  });

  it('同じ案件の再読み込みも先に切断を記録し、失敗したら現在状態を保つ', () => {
    const disconnect = vi.fn().mockImplementationOnce(() => { throw new Error('STORE_BUSY'); });
    const registry = new EditorSessionRegistry(disconnect); const before = heartbeat();
    registry.heartbeat(before);
    const loading = heartbeat({ sequence: 2, snapshot: { status: 'loading', projectId: 'project-a' } });
    expect(() => registry.heartbeat(loading)).toThrow(/STORE_BUSY/);
    expect(registry.snapshot('window-a')).toEqual(before.snapshot);
    registry.heartbeat(loading);
    expect(registry.snapshot('window-a')).toEqual(loading.snapshot);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('案件の読込失敗を本文なしの接続状態として保持する', () => {
    const registry = new EditorSessionRegistry(vi.fn(), () => 1000, 100);
    registry.heartbeat(heartbeat({ snapshot: { status: 'error', projectId: 'project-a' } }));
    expect(registry.list()).toEqual([{ sessionId: 'window-a', status: 'error', projectId: 'project-a', revision: null,
      dirty: false, saving: false, humanBusy: false, elementCount: 0, expiresAt: 1100 }]);
    expect(registry.snapshot('window-a')).toEqual({ status: 'error', projectId: 'project-a' });
  });

  it('不正な範囲・重複ID・readyに無関係な属性を入力境界で拒否する', () => {
    const registry = new EditorSessionRegistry(vi.fn());
    const input = heartbeat();
    expect(() => registry.heartbeat({ ...input, snapshot: { ...input.snapshot,
      elements: [...input.snapshot.elements, ...input.snapshot.elements] } })).toThrow(/重複/);
    expect(() => registry.heartbeat({ ...input, snapshot: { ...input.snapshot,
      elements: [{ ...input.snapshot.elements[0], sourceFrameRange: { start: 30, end: 30 } }] } })).toThrow(/逆転/);
    expect(() => registry.heartbeat({ ...input, snapshot: { status: 'home', projectId: null, dirty: false } })).toThrow();
    expect(() => registry.heartbeat({ ...input, sequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(registry.list()).toEqual([]);
  });
});

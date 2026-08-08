import { describe, expect, it, test, vi } from 'vitest';
import { createInstructionInbox, DEDICATED_GRACE_MS, isAgentConnected } from './instructionInbox';
import type { InstructionContext } from '../shared/types';

const CTX: InstructionContext = { frame: 30, timeSec: 1, selection: null };

function input(text: string, projectId = 'projA') {
  return { projectId, projectDir: `/abs/${projectId}`, text, context: CTX };
}

describe('createInstructionInbox（同期操作）', () => {
  it('enqueue は pending の新規レコードを採番して返す', () => {
    const inbox = createInstructionInbox();
    const rec = inbox.enqueue(input('赤にして'));
    expect(rec.id).toBeTruthy();
    expect(rec.status).toBe('pending');
    expect(rec.text).toBe('赤にして');
    expect(rec.projectDir).toBe('/abs/projA');
    expect(rec.reply).toBeNull();
  });

  it('takeNext は最古の pending を processing にして返す（FIFO）', () => {
    const inbox = createInstructionInbox();
    const a = inbox.enqueue(input('1番目'));
    inbox.enqueue(input('2番目'));
    const taken = inbox.takeNext();
    expect(taken?.id).toBe(a.id);
    expect(taken?.status).toBe('processing');
  });

  it('takeNext は pending が無ければ null', () => {
    const inbox = createInstructionInbox();
    expect(inbox.takeNext()).toBeNull();
    const a = inbox.enqueue(input('x'));
    inbox.takeNext(); // a を取る → processing
    expect(inbox.takeNext()).toBeNull(); // processing は対象外
    expect(a.id).toBeTruthy();
  });

  it('updateStatus は状態と返答を更新する（processing からのみ受理）', () => {
    const inbox = createInstructionInbox();
    const a = inbox.enqueue(input('x'));
    inbox.takeNext(); // pending→processing にしてから報告する（遷移ガード）
    const updated = inbox.updateStatus(a.id, 'done', '完了しました');
    expect(updated?.status).toBe('done');
    expect(updated?.reply).toBe('完了しました');
    expect(inbox.updateStatus('missing', 'done')).toBeNull();
  });

  it('list は projectId で絞り、作成順で返す', () => {
    const inbox = createInstructionInbox();
    inbox.enqueue(input('a1', 'projA'));
    inbox.enqueue(input('b1', 'projB'));
    inbox.enqueue(input('a2', 'projA'));
    expect(inbox.list('projA').map((r) => r.text)).toEqual(['a1', 'a2']);
    expect(inbox.list('projB').map((r) => r.text)).toEqual(['b1']);
  });
});

describe('takeOrWait（ロングポーリング）', () => {
  it('pending があれば待たずに即 resolve する', async () => {
    const inbox = createInstructionInbox();
    inbox.enqueue(input('即'));
    const rec = await inbox.takeOrWait(10_000);
    expect(rec?.text).toBe('即');
    expect(rec?.status).toBe('processing');
  });

  it('pending が無ければ待ち、enqueue で起床して返す', async () => {
    vi.useFakeTimers();
    try {
      const inbox = createInstructionInbox();
      const p = inbox.takeOrWait(10_000);
      inbox.enqueue(input('あとから'));
      const rec = await p;
      expect(rec?.text).toBe('あとから');
      expect(rec?.status).toBe('processing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('待っても来なければ waitMs 経過で null', async () => {
    vi.useFakeTimers();
    try {
      const inbox = createInstructionInbox();
      const p = inbox.takeOrWait(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

import { validateInstructionInput } from './instructionInbox';
import { HttpError } from './http';

describe('validateInstructionInput', () => {
  const okCtx = { frame: 10, timeSec: 0.33, selection: null };

  it('オブジェクトでない本文を 400 で弾く', () => {
    expect(() => validateInstructionInput(null)).toThrow(HttpError);
    expect(() => validateInstructionInput('x')).toThrow(HttpError);
  });

  it('projectId / text が空だと 400', () => {
    expect(() => validateInstructionInput({ projectId: '', text: 'a', context: okCtx })).toThrow(/projectId/);
    expect(() => validateInstructionInput({ projectId: 'p', text: '', context: okCtx })).toThrow(/text/);
  });

  it('context.frame が数値でないと 400', () => {
    expect(() => validateInstructionInput({ projectId: 'p', text: 'a', context: { ...okCtx, frame: 'x' } })).toThrow(/context/);
  });

  it('selection は null か {kind,id} のみ許可', () => {
    expect(() => validateInstructionInput({ projectId: 'p', text: 'a', context: { frame: 0, timeSec: 0, selection: { kind: 'telop', id: 't1' } } })).not.toThrow();
    expect(() => validateInstructionInput({ projectId: 'p', text: 'a', context: { frame: 0, timeSec: 0, selection: { kind: 'bogus', id: 't1' } } })).toThrow(/selection/);
  });

  it('正常入力を InstructionInput として返す', () => {
    const parsed = validateInstructionInput({ projectId: 'p', text: '赤にして', context: okCtx });
    expect(parsed.projectId).toBe('p');
    expect(parsed.text).toBe('赤にして');
    expect(parsed.context.selection).toBeNull();
  });
});

describe('agentStatus / isAgentConnected（AI タブの接続表示）', () => {
  it('初期状態は未接続シグナル（waiting 0・lastPollAt null・processing false）', () => {
    const inbox = createInstructionInbox();
    expect(inbox.agentStatus()).toEqual({ waiting: 0, lastPollAt: null, processing: false });
  });

  it('takeOrWait のブロック中は waiting が 1 になり、解決で 0 に戻る', async () => {
    const inbox = createInstructionInbox();
    const p = inbox.takeOrWait(50); // pending 無し → ブロック
    expect(inbox.agentStatus().waiting).toBe(1);
    expect(inbox.agentStatus().lastPollAt).not.toBeNull();
    await p; // タイムアウトで null 解決
    expect(inbox.agentStatus().waiting).toBe(0);
  });

  it('即時取得（pending あり）でも lastPollAt が記録される', async () => {
    const inbox = createInstructionInbox();
    inbox.enqueue(input('x'));
    await inbox.takeOrWait(10);
    expect(inbox.agentStatus().lastPollAt).not.toBeNull();
    // 取り出した指示が processing のまま＝エージェント作業中シグナル
    expect(inbox.agentStatus().processing).toBe(true);
  });

  it('isAgentConnected: waiting>0 か processing か lastPollAt が猶予内なら接続中', () => {
    const now = 1_000_000;
    expect(isAgentConnected({ waiting: 1, lastPollAt: null, processing: false }, now)).toBe(true);
    expect(isAgentConnected({ waiting: 0, lastPollAt: null, processing: true }, now)).toBe(true);
    expect(isAgentConnected({ waiting: 0, lastPollAt: now - 60_000, processing: false }, now)).toBe(true);
    expect(isAgentConnected({ waiting: 0, lastPollAt: now - 200_000, processing: false }, now)).toBe(false);
    expect(isAgentConnected({ waiting: 0, lastPollAt: null, processing: false }, now)).toBe(false);
  });
});

describe('並列配送', () => {
  function enq(inbox: ReturnType<typeof createInstructionInbox>, projectId: string, text = 'x') {
    return inbox.enqueue({ projectId, projectDir: `/tmp/${projectId}`, text, context: { frame: 0, timeSec: 0, selection: null } });
  }

  test('同一プロジェクトは配送中1件のみ・別プロジェクトは並列に取れる', () => {
    const inbox = createInstructionInbox();
    enq(inbox, 'A'); enq(inbox, 'A'); enq(inbox, 'B');
    const first = inbox.takeNext();          // A の1件目
    expect(first?.projectId).toBe('A');
    const second = inbox.takeNext();         // A はスキップされ B が返る
    expect(second?.projectId).toBe('B');
    expect(inbox.takeNext()).toBeNull();     // A の2件目は配送されない
    inbox.updateStatus(first!.id, 'done', 'ok');
    expect(inbox.takeNext()?.projectId).toBe('A'); // done で解放
  });

  test('projectId フィルタは指定プロジェクトの pending だけ返す', () => {
    const inbox = createInstructionInbox();
    enq(inbox, 'A'); enq(inbox, 'B');
    expect(inbox.takeNext({ projectId: 'B' })?.projectId).toBe('B');
    expect(inbox.takeNext({ projectId: 'B' })).toBeNull();
  });

  test('専属在席が新鮮なプロジェクトの pending はグローバル取得がスキップする', () => {
    let now = 1_000_000;
    const inbox = createInstructionInbox({ now: () => now });
    // 専属 poll（empty でも在席は記録される）
    void inbox.takeOrWait(0, 'A');
    enq(inbox, 'A'); enq(inbox, 'B');
    expect(inbox.takeNext()?.projectId).toBe('B');            // A は専属向けに温存
    now += DEDICATED_GRACE_MS + 1;
    expect(inbox.takeNext()?.projectId).toBe('A');            // stale 後は引き継ぎ
  });

  test('グローバル同時配送は maxGlobalParallel で頭打ち・done で解放', () => {
    const inbox = createInstructionInbox({ maxGlobalParallel: 2 });
    enq(inbox, 'A'); enq(inbox, 'B'); enq(inbox, 'C');
    const a = inbox.takeNext(); const b = inbox.takeNext();
    expect(a && b).toBeTruthy();
    expect(inbox.takeNext()).toBeNull();                      // 上限
    inbox.updateStatus(a!.id, 'done', 'ok');
    expect(inbox.takeNext()?.projectId).toBe('C');
  });

  test('専属取得はグローバル上限に数えない', () => {
    const inbox = createInstructionInbox({ maxGlobalParallel: 1 });
    enq(inbox, 'A'); enq(inbox, 'B');
    expect(inbox.takeNext({ projectId: 'A' })).not.toBeNull();
    expect(inbox.takeNext()?.projectId).toBe('B');            // 専属分は上限外
  });

  test('遷移ガード: 打ち切り後の遅延 done を拒否・二重報告を拒否', () => {
    const inbox = createInstructionInbox();
    const r = enq(inbox, 'A');
    inbox.takeNext();
    expect(inbox.abort(r.id)?.status).toBe('failed');
    expect(inbox.updateStatus(r.id, 'done', '遅延報告')).toBeNull();  // failed→done 反転不可
    const [record] = inbox.list('A');
    expect(record?.status).toBe('failed');
    expect(inbox.abort(r.id)).toBeNull();                              // pending/failed への abort 不可
  });

  test('done/failed 報告で待機中のグローバル waker が起きる（直列解放の起床）', async () => {
    const inbox = createInstructionInbox();
    const a1 = enq(inbox, 'A'); enq(inbox, 'A');
    inbox.takeNext();
    const waiterPromise = inbox.takeOrWait(5_000);            // A2 は配送不可でブロック
    inbox.updateStatus(a1.id, 'done', 'ok');
    const got = await waiterPromise;
    expect(got?.projectId).toBe('A');
  });

  test('enqueue は専属 waker を優先して起こす', async () => {
    const inbox = createInstructionInbox();
    const dedicated = inbox.takeOrWait(5_000, 'A');
    const global = inbox.takeOrWait(5_000);
    enq(inbox, 'A');
    expect((await dedicated)?.projectId).toBe('A');
    enq(inbox, 'B');
    expect((await global)?.projectId).toBe('B');
  });

  test('agentStatus: 専属 poll はグローバル在席に混ざらない・dedicated.connected が出る', () => {
    let now = 1_000_000;
    const inbox = createInstructionInbox({ now: () => now });
    void inbox.takeOrWait(0, 'A');
    const g = inbox.agentStatus();
    expect(g.lastPollAt).toBeNull();                          // グローバル在席は不変
    expect(inbox.agentStatus('A').dedicated?.connected).toBe(true);
    expect(inbox.agentStatus('B').dedicated?.connected).toBe(false);
  });

  test('専属レコードへの done 報告も専属在席を更新する', () => {
    let now = 1_000_000;
    const inbox = createInstructionInbox({ now: () => now });
    void inbox.takeOrWait(0, 'A');
    const r = enq(inbox, 'A');
    inbox.takeNext({ projectId: 'A' });
    now += DEDICATED_GRACE_MS + 1;                            // poll は stale
    inbox.updateStatus(r.id, 'done', 'ok');                   // 報告が在席を更新
    enq(inbox, 'A');
    expect(inbox.takeNext()).toBeNull();                      // グローバルは温存する
  });
});

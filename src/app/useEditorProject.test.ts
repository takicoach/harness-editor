/**
 * @vitest-environment jsdom
 */
/**
 * useEditorProject フックのユニットテスト。
 *
 * reloadIfSafe と一覧取得の順序（J-0）を検証する。isCurrent / clearExternalChange /
 * projectsLoading は useEditorProject.test.tsx 側。
 * fetch はモックし、useProjectWatch の EventSource 依存も jsdom スタブで無害化する。
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

/**
 * B-4: 非同期処理（導入・部品更新など）の着地時に、今のプロジェクトを安全に開き直せるかを
 * 一箇所で判定する reloadIfSafe(id, dirty) の回帰テスト。
 *
 * handleConvert の convertingRef + selectedIdRef 照合と同じ「切替済みなら結果を捨てる」ガードに、
 * 「未保存編集（dirty）があるなら黙って reload しない」を足して handleInstall /
 * PackUpgradeBanner.onUpgraded の両方へ広げるための土台。
 */
describe('useEditorProject().reloadIfSafe', () => {
  function setUp() {
    vi.stubGlobal('EventSource', FakeEventSource);
    let projectFetchCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/projects')) {
        return Promise.resolve({ ok: true, json: async () => ({ root: '/tmp', projects: [] }) });
      }
      if (url.startsWith('/api/project?')) {
        projectFetchCount += 1;
        // 内部読込の完了は待たず、reload が「新しい読込を開始したか」だけを見る。
        return new Promise(() => {});
      }
      return new Promise(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);
    return { getProjectFetchCount: () => projectFetchCount };
  }

  it('切替済み（別プロジェクトを選択中）なら reload しない・false を返す', async () => {
    setUp();
    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());

    act(() => {
      result.current.selectProject('a');
    });
    act(() => {
      result.current.selectProject('b');
    });

    let ok = true;
    act(() => {
      ok = result.current.reloadIfSafe('a', false);
    });
    expect(ok).toBe(false);
  });

  it('未保存編集（dirty）があるなら、今のプロジェクトでも reload せず false を返す（編集を黙って捨てない）', async () => {
    const { getProjectFetchCount } = setUp();
    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());

    act(() => {
      result.current.selectProject('a');
    });
    const before = getProjectFetchCount();

    let ok = true;
    act(() => {
      ok = result.current.reloadIfSafe('a', true);
    });
    expect(ok).toBe(false);
    // dirty なら新規の読込（＝実質 reload）を一切開始しない。
    expect(getProjectFetchCount()).toBe(before);
  });

  it('今のプロジェクトかつ dirty でなければ reload して true を返す', async () => {
    const { getProjectFetchCount } = setUp();
    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());

    act(() => {
      result.current.selectProject('a');
    });
    const before = getProjectFetchCount();

    let ok = false;
    act(() => {
      ok = result.current.reloadIfSafe('a', false);
    });
    expect(ok).toBe(true);
    expect(getProjectFetchCount()).toBeGreaterThan(before);
  });
});

/**
 * 一覧の全置換（`/api/projects` の応答）と SSE のライブ差分の**順序**の回帰テスト。
 *
 * 症状: 左サイドバーの「AI 作業中」（`.fb-item.fb-working`）が出た直後に消える／
 * 逆に終わったはずの「作業中」が消えずに残る。どちらもディスクは変わらないので
 * 新しい SSE イベントは来ず、次の一覧再取得まで直らない。
 *
 * 直った後の規律: どちらの観測が新しいかを**到着順で推測しない**。サーバが観測ごとに
 * 振る単調増加の番号（statusSeq）だけで決める。ここでは interleaving をテスト側で
 * 確定的に作り、偶然に頼らず（毎回落ちる／毎回通る形で）その規律を検査する。
 */
describe('useEditorProject() 一覧取得とライブ差分の順序', () => {
  const summary = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, dir: `/tmp/${id}`, status: 'idle', ...extra }) as unknown as import('../shared/types').ProjectSummary;

  /** `/api/projects` の応答を1件ずつ手で着地させられるフックを立てる。 */
  function setUpPendingProjects() {
    vi.stubGlobal('EventSource', FakeEventSource);
    const pending: Array<(projects: unknown[]) => void> = [];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/projects')) {
        return new Promise((resolve) => {
          pending.push((projects) => {
            resolve({ ok: true, json: async () => ({ root: '/tmp', projects }) });
          });
        });
      }
      return new Promise(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);
    return pending;
  }

  it('応答待ちの間に届いたライブ差分を、遅れて着地した古い一覧が巻き戻さない', async () => {
    const pending = setUpPendingProjects();
    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());

    // 初回取得を着地させる（activity 無し・観測 10）。
    await act(async () => {
      pending.shift()?.([summary('p1', { statusSeq: 10 })]);
    });
    expect(result.current.projects).toHaveLength(1);

    // 再取得を開始（＝SSE 再接続時の onOpen → refreshProjects 相当）。まだ着地しない。
    act(() => {
      void result.current.refreshProjects();
    });
    // 応答待ちの間に SSE の status 差分が届く（観測 20 ＝ より新しい）。
    act(() => {
      result.current.patchProject('p1', { activityLabel: 'カット中', statusSeq: 20 });
    });
    expect(result.current.projects[0]?.activityLabel).toBe('カット中');

    // 要求時点のスナップショット（観測 15・activity 無し）が遅れて着地する。
    await act(async () => {
      pending.shift()?.([summary('p1', { statusSeq: 15 })]);
    });

    expect(
      result.current.projects[0]?.activityLabel,
      '遅れて着地した古い一覧がライブ差分を巻き戻している',
    ).toBe('カット中');
  });

  it('遅れて届いた古いライブ差分が、より新しい一覧を巻き戻さない（幽霊「作業中」の防止）', async () => {
    // 実際に起きる並び: 作業が終わって activity が消えた後に、消える前の観測から出た
    // SSE 差分が遅れて着地する。到着順で上書きすると「作業中」が消えないまま残り、
    // ディスクはもう変わらないので次のイベントも来ない。
    const pending = setUpPendingProjects();
    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());

    // 初回取得（観測 10・作業中）。
    await act(async () => {
      pending.shift()?.([summary('p1', { statusSeq: 10, activityLabel: 'カット中' })]);
    });
    expect(result.current.projects[0]?.activityLabel).toBe('カット中');

    // 作業が終わった後の一覧（観測 30・activity 無し）が着地する。
    act(() => {
      void result.current.refreshProjects();
    });
    await act(async () => {
      pending.shift()?.([summary('p1', { statusSeq: 30 })]);
    });
    expect(result.current.projects[0]?.activityLabel).toBeUndefined();

    // 消える前の観測（20）から出た差分が遅れて着地する。ここで復活してはいけない。
    act(() => {
      result.current.patchProject('p1', { activityLabel: 'カット中', statusSeq: 20 });
    });
    // 「崩れていない」の前に「その行が実在するか」を検査する（存在検査の並設）。
    // 最終判定は `projects[0]?.activityLabel` の undefined なので、マージが行ごと
    // 落とす退行が起きても素通りしてしまう。空リストはいつでも綺麗に見える。
    expect(
      result.current.projects.map((p) => p.id),
      '一覧マージが行を落としている（空リストでは activityLabel の検査が意味を持たない）',
    ).toEqual(['p1']);
    expect(
      result.current.projects[0]?.activityLabel,
      '古いライブ差分が新しい一覧を巻き戻して「作業中」が復活している',
    ).toBeUndefined();
  });

  it('一覧の応答同士が入れ替わって着地しても、新しい観測が勝つ', async () => {
    // 一覧再取得は複数の経路（バス再接続の onOpen・ホームへ戻る・ステータス変更後）から
    // ほぼ同時に走る。2 本の GET はどちらが先に着地するか決まっていない。
    const pending = setUpPendingProjects();
    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());

    await act(async () => {
      pending.shift()?.([summary('p1', { statusSeq: 10 })]);
    });

    // 2 本の再取得を開始する。
    act(() => {
      void result.current.refreshProjects();
      void result.current.refreshProjects();
    });
    // 新しい観測（30・作業中）が先に着地し、古い観測（15）が後から着地する。
    await act(async () => {
      pending.shift()?.([summary('p1', { statusSeq: 30, activityLabel: 'カット中' })]);
    });
    expect(result.current.projects[0]?.activityLabel).toBe('カット中');
    await act(async () => {
      pending.shift()?.([summary('p1', { statusSeq: 15 })]);
    });

    expect(
      result.current.projects[0]?.activityLabel,
      '後から着地した古い一覧が新しい一覧を巻き戻している',
    ).toBe('カット中');
  });

  it('番号を持たない楽観更新（バッジ操作）は常に反映される', async () => {
    const pending = setUpPendingProjects();
    const { useEditorProject } = await import('./useEditorProject');
    const { result } = renderHook(() => useEditorProject());
    await act(async () => {
      pending.shift()?.([summary('p1', { statusSeq: 10 })]);
    });
    act(() => {
      result.current.patchProject('p1', { status: 'telop', stageManual: true });
    });
    expect(result.current.projects[0]?.status).toBe('telop');
    expect(result.current.projects[0]?.stageManual).toBe(true);
  });
});

describe('mergeProjectSummaries / applyStatusPatch（純関数）', () => {
  const entry = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, dir: `/tmp/${id}`, status: 'idle', snapshotSeq: 0, ...extra }) as unknown as
      import('./useEditorProject').ProjectListEntry;
  const summary = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, dir: `/tmp/${id}`, status: 'idle', ...extra }) as unknown as import('../shared/types').ProjectSummary;

  it('applyStatusPatch: 一覧に居ない id のパッチは捨てる', async () => {
    const { applyStatusPatch } = await import('./useEditorProject');
    const list = [entry('a', { statusSeq: 1 }), entry('b', { statusSeq: 1 })];
    let next = applyStatusPatch(list, 'a', { activityLabel: 'x', statusSeq: 2 });
    next = applyStatusPatch(next, 'zzz', { activityLabel: 'y', statusSeq: 3 });
    next = applyStatusPatch(next, 'a', { activityLabel: 'z', statusSeq: 4 });
    expect(next.map((p) => p.activityLabel)).toEqual(['z', undefined]);
    expect(next).toHaveLength(2);
  });

  it('applyStatusPatch: 同じ番号の再送は重ねない（重複配信で状態が揺れない）', async () => {
    const { applyStatusPatch } = await import('./useEditorProject');
    const list = [entry('a', { statusSeq: 5, activityLabel: 'カット中' })];
    const next = applyStatusPatch(list, 'a', { activityLabel: undefined, statusSeq: 5 });
    expect(next[0]?.activityLabel).toBe('カット中');
  });

  it('mergeProjectSummaries: 一覧が新しければ構造フィールドもステータスも一覧が勝つ', async () => {
    const { mergeProjectSummaries } = await import('./useEditorProject');
    const prev = [entry('a', { statusSeq: 5, snapshotSeq: 5, durationLabel: '0:10' })];
    const next = mergeProjectSummaries(prev, [
      summary('a', { statusSeq: 9, durationLabel: '1:00', activityLabel: 'カット中' }),
    ]);
    expect(next[0]?.durationLabel).toBe('1:00');
    expect(next[0]?.activityLabel).toBe('カット中');
    expect(next[0]?.statusSeq).toBe(9);
    expect(next[0]?.snapshotSeq).toBe(9);
  });

  it('mergeProjectSummaries: 一覧が古くても構造フィールドは更新し、ステータスだけ手元を残す', async () => {
    const { mergeProjectSummaries } = await import('./useEditorProject');
    // 手元は「観測 5 の一覧 ＋ 観測 9 のライブ差分」。着地した一覧は観測 7。
    const prev = [
      entry('a', { statusSeq: 9, snapshotSeq: 5, durationLabel: '0:10', activityLabel: 'カット中' }),
    ];
    const next = mergeProjectSummaries(prev, [summary('a', { statusSeq: 7, durationLabel: '1:00' })]);
    expect(next[0]?.durationLabel, '一覧の方が新しい構造フィールドは取り込む').toBe('1:00');
    expect(next[0]?.activityLabel, 'ライブ差分の方が新しいステータスは残す').toBe('カット中');
    expect(next[0]?.statusSeq).toBe(9);
    expect(next[0]?.snapshotSeq).toBe(7);
  });

  it('mergeProjectSummaries: 一覧に無い id は消える（削除が反映される）', async () => {
    const { mergeProjectSummaries } = await import('./useEditorProject');
    const prev = [entry('a', { statusSeq: 9 }), entry('b', { statusSeq: 9 })];
    const next = mergeProjectSummaries(prev, [summary('a', { statusSeq: 10 })]);
    expect(next.map((p) => p.id)).toEqual(['a']);
  });

  it('mergeProjectSummaries: 番号を知らないサーバの応答は従来どおり全置換', async () => {
    const { mergeProjectSummaries } = await import('./useEditorProject');
    const prev = [entry('a', { statusSeq: 9, activityLabel: 'カット中' })];
    const next = mergeProjectSummaries(prev, [summary('a')]);
    expect(next[0]?.activityLabel).toBeUndefined();
  });
});

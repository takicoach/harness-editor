/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PreferenceDialog } from './PreferenceDialog';
import type { PreferenceWorkspace } from '../../learning/preferenceWorkspaceStore';
import type { JudgmentExample } from '../../learning/preferenceDecisions';
import type { PreferenceRule } from '../../learning/preferenceRules';
import type { EditorReviewTarget } from '../../shared/editorReview';

const empty = (): PreferenceWorkspace => ({ schemaVersion: 1, decisions: { schemaVersion: 1, events: [] }, rules: [],
  evaluations: [], datasets: [], profiles: [{ id: 'golf', name: 'ゴルフ解説' }], projectProfiles: { video: 'golf' }, operations: [] });
let commands: Record<string, unknown>[];
let failNext: boolean;
let workspace: PreferenceWorkspace;
beforeEach(() => {
  commands = []; failNext = false; workspace = empty(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/command')) {
      const command = JSON.parse(String(options?.body)); commands.push(command);
      if (failNext) { failNext = false; throw new TypeError('network failure'); }
    }
    return { ok: true, json: async () => workspace };
  }));
});

describe('AIがすでに編集した字幕への人の判断', () => {
  const initialReview: EditorReviewTarget = { proposalId: 'editor:run:0', runId: 'run', projectId: 'video', baseRevision: 'original-revision',
    change: { type: 'set_telop_text', elementId: '1', before: '素振りする', after: '素振りをする', sourceFrameRange: { start: 0, end: 30 } } };
  function openReview(onApply = vi.fn(async () => {})) {
    render(<PreferenceDialog projectId="video" projectName="練習動画" selectedElementId={null} initialReview={initialReview}
      getTarget={() => ({ projectId: 'video', projectRevision: 'current-revision',
        elements: [{ id: '1', text: '人があとで直した本文', sourceFrameRange: { start: 0, end: 30 } }] })}
      onApply={onApply} onClose={vi.fn()} />);
    return onApply;
  }
  it('今の本文を表示し、却下で現在版を照合してから戻し、元提案に紐付けて記録する', async () => {
    const apply = openReview();
    await screen.findByLabelText('提案する本文');
    expect(screen.getByText(/現在の字幕：人があとで直した本文/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '却下して戻す' }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ before: '人があとで直した本文', projectRevision: 'current-revision' }), '素振りする', false);
    expect(commands[0]?.event).toMatchObject({ proposalId: 'editor:run:0', projectRevision: 'original-revision',
      before: '素振りする', proposedAfter: '素振りをする', actualAfter: null, decision: 'rejected', learningConsent: false });
  });
  it('保留では編集せず、応答不明からの再確認でも二重編集しない', async () => {
    const apply = openReview(); failNext = true;
    await screen.findByLabelText('提案する本文');
    fireEvent.click(screen.getByRole('button', { name: '後で判断' }));
    fireEvent.click(await screen.findByRole('button', { name: '同じ記録の保存を再確認' }));
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[0]).toEqual(commands[1]); expect(apply).not.toHaveBeenCalled();
    expect(commands[0]?.event).toMatchObject({ proposalId: 'editor:run:0', decision: 'deferred', actualAfter: null });
  });
  it('採用前に現在版が変わったら人の判断を記録しない', async () => {
    openReview(vi.fn(async () => { throw new Error('STALE_PROPOSAL'); }));
    await screen.findByLabelText('提案する本文');
    fireEvent.click(screen.getByRole('button', { name: '採用' }));
    await screen.findByRole('alert'); expect(commands).toHaveLength(0);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
function open(
  onApply = vi.fn(async () => {}),
  getTarget = () => ({ projectId: 'video', projectRevision: 'revision-1', elements: [{ id: '1', text: '素振りする', sourceFrameRange: { start: 0, end: 30 } }] }),
) {
  render(<PreferenceDialog projectId="video" projectName="練習動画" selectedElementId="1"
    getTarget={getTarget}
    onApply={onApply} onClose={vi.fn()} />);
  return onApply;
}
describe('採否と学習同意を分ける画面', () => {
  it('採用だけでは同意を付けず、字幕反映を確認してから記録する', async () => {
    const apply = open();
    const input = await screen.findByLabelText('提案する本文');
    const consent = screen.getByRole('checkbox', { name: /この判断を今後の好みに使う/ }) as HTMLInputElement;
    expect(consent.checked).toBe(false);
    fireEvent.change(input, { target: { value: '素振りをする' } });
    fireEvent.click(screen.getByRole('button', { name: '採用' }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(commands[0]?.event).toMatchObject({ decision: 'accepted', actualAfter: '素振りをする', learningConsent: false,
      scope: { kind: 'project', id: 'video' }, reasonCode: 'unspecified' });
  });
  it('同意した却下を負例として保存し、字幕の編集は呼ばない', async () => {
    const apply = open();
    fireEvent.change(await screen.findByLabelText('提案する本文'), { target: { value: '別の提案' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /この判断を今後の好みに使う/ }));
    fireEvent.click(screen.getByRole('button', { name: '却下' }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(apply).not.toHaveBeenCalled();
    expect(commands[0]?.event).toMatchObject({ decision: 'rejected', actualAfter: null, learningConsent: true,
      scope: { kind: 'profile', id: 'golf' } });
  });
  it('古い字幕などで編集が拒否された場合に、採用したと記録しない', async () => {
    const apply = vi.fn(async () => { throw new Error('STALE_PROPOSAL'); }); open(apply);
    fireEvent.change(await screen.findByLabelText('提案する本文'), { target: { value: '素振りをする' } });
    fireEvent.click(screen.getByRole('button', { name: '採用' }));
    await screen.findByRole('alert');
    expect(commands).toHaveLength(0);
  });
  it('応答不明の保存は同じ操作IDで再確認し、現在の本文へフォームを戻す', async () => {
    let currentText = '素振りする';
    const apply = vi.fn(async (_proposal, actualAfter: string) => { currentText = actualAfter; });
    open(apply, () => ({ projectId: 'video', projectRevision: 'revision-2', elements: [{ id: '1', text: currentText, sourceFrameRange: { start: 0, end: 30 } }] }));
    failNext = true;
    fireEvent.change(await screen.findByLabelText('提案する本文'), { target: { value: '素振りをする' } });
    fireEvent.change(screen.getByLabelText('判断の理由'), { target: { value: 'tone' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /この判断を今後の好みに使う/ }));
    fireEvent.click(screen.getByRole('button', { name: '採用' }));
    const retry = await screen.findByRole('button', { name: '同じ記録の保存を再確認' });
    expect(sessionStorage.getItem('sme-preference-pending-command-v1')).not.toBeNull();
    fireEvent.click(retry);
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[0]).toEqual(commands[1]); expect(apply).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(sessionStorage.getItem('sme-preference-pending-command-v1')).toBeNull());
    expect(screen.getByText('素振りをする', { selector: '.preference-before' })).toBeTruthy();
    expect((screen.getByLabelText('提案する本文') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText('判断の理由') as HTMLSelectElement).value).toBe('unspecified');
    expect((screen.getByRole('checkbox', { name: /この判断を今後の好みに使う/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: '却下' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// Component-only contract fixture. It is never written to the learning store or counted as a real human evaluation.
const judgment: JudgmentExample = {
  schemaVersion: 1, type: 'judgment', id: 'evidence', operationId: 'evidence-operation', createdAt: '2026-09-07T00:00:00.000Z',
  actor: { kind: 'human', id: 'coach' }, editKind: 'telop_text', projectId: 'source-video', projectRevision: 'source-revision',
  elementId: 'source-telop', sourceFrameRange: { start: 0, end: 30 }, before: '素振りする', proposedAfter: '素振りをする',
  actualAfter: '素振りをする', decision: 'accepted', reasonCode: 'wording', note: '', scope: { kind: 'profile', id: 'golf' },
  learningConsent: true, provenance: { kind: 'human' },
};

function rule(status: PreferenceRule['status'] = 'active', options: { scope?: string; exceptions?: string[]; invalidEvaluation?: boolean } = {}): PreferenceRule {
  return {
    schemaVersion: 1, id: `rule-${status}-${options.invalidEvaluation ? 'invalid' : 'base'}`, version: 1, status,
    editKind: 'telop_text', scope: { kind: 'profile', id: options.scope ?? 'golf' }, conditions: { textEquals: '素振りする' },
    action: { kind: 'replace_text', text: '素振りをする' }, exceptions: { projectIds: options.exceptions ?? [] },
    evidenceIds: ['evidence'], createdAt: '2026-09-07T00:00:00.000Z',
    ...(status === 'candidate' ? {} : { activation: { actorId: 'coach', evaluationId: 'evaluation', at: '2026-09-07T00:00:00.000Z',
      dataset: { id: 'dataset', version: 1, hash: 'a'.repeat(64) },
      caseDependencies: [{ decisionId: options.invalidEvaluation ? 'missing' : judgment.id,
        operationId: options.invalidEvaluation ? 'missing-operation' : judgment.operationId }] } }),
  };
}

async function openRules(next: PreferenceWorkspace) {
  workspace = next;
  const onApply = open();
  fireEvent.click(screen.getByRole('button', { name: '好みのルール' }));
  await screen.findByText(/候補 → 評価 → 人が有効化/);
  return onApply;
}

describe('実例から明示する語句条件', () => {
  it('実例を再現できる条件だけを候補として送り、字幕反映も有効化もしない', async () => {
    // Invented interface fixture, not real human judgment evidence.
    workspace.decisions.events = [{...judgment, before: '長いアイアソ2本ですね', proposedAfter: '長いアイアン2本ですね', actualAfter: '長いアイアン2本ですね'}];
    const apply = open();
    await screen.findByLabelText('提案する本文');
    fireEvent.click(screen.getByRole('button', {name: '判断の記録'}));
    fireEvent.click(screen.getByRole('button', {name: '語句のルールにする'}));
    const save = screen.getByRole('button', {name: '語句の候補を保存'}) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('置換前の語句'), {target: {value: 'アイアソ'}});
    fireEvent.change(screen.getByLabelText('置換後の語句'), {target: {value: 'ウッド'}});
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('置換後の語句'), {target: {value: 'アイアン'}});
    fireEvent.change(screen.getByLabelText('使わない字幕の目印（1行に1つ）'), {target: {value: '引用：\n商品名は'}});
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toMatchObject({kind: 'candidate', evidenceIds: [judgment.id], fragment: {from: 'アイアソ', to: 'アイアン', exceptTextIncludes: ['引用：', '商品名は']}});
    expect(apply).not.toHaveBeenCalled();
  });
  it('語句ルールの条件・全出現置換・除外を表示し、全文一致とは説明しない', async () => {
    const state = empty();state.decisions.events = [{...judgment, before: '長いアイアソ2本ですね', proposedAfter: '長いアイアン2本ですね', actualAfter: '長いアイアン2本ですね'}];
    state.rules = [{...rule(), schemaVersion: 2, conditions: {textIncludes: 'アイアソ', exceptTextIncludes: ['引用：', '商品名は']}, action: {kind: 'replace_occurrences', text: 'アイアン'}}];
    await openRules(state);
    expect(screen.getByText('字幕内の「アイアソ」をすべて「アイアン」へ置換する提案')).toBeTruthy();
    expect(screen.getByText('使わない字幕の目印：「引用：」、「商品名は」')).toBeTruthy();
    expect(screen.getByText('利用できます。指定した語句を含み、除外の目印を含まない字幕で提案の対象になります。')).toBeTruthy();
    expect(screen.queryByText('利用できます。本文が完全に一致したときに提案の対象になります。')).toBeNull();
  });
  it('合成実例から語句ルールを作って人の根拠にすることはできない', async () => {
    workspace.decisions.events = [{...judgment, provenance: {kind: 'synthetic'}}];
    open();await screen.findByLabelText('提案する本文');
    fireEvent.click(screen.getByRole('button', {name: '判断の記録'}));
    expect((screen.getByRole('button', {name: '語句のルールにする'}) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('この動画でのルール利用可否', () => {
  it.each([
    ['方針一致', 'golf', [], '利用できます。本文が完全に一致したときに提案の対象になります。'],
    ['方針未指定', null, [], '編集方針が未指定のため、利用しません。'],
    ['別方針', 'talk', [], 'この動画の編集方針とは異なるため、利用しません。'],
    ['この動画が例外', 'golf', ['video'], 'この動画は例外に指定されているため、利用しません。'],
    ['別動画だけが例外', 'golf', ['another-video'], '利用できます。本文が完全に一致したときに提案の対象になります。'],
  ] as const)('%sをカード内で説明する', async (_label, projectProfile, exceptions, expected) => {
    const next = empty();
    next.profiles.push({ id: 'talk', name: '対談' });
    next.projectProfiles.video = projectProfile;
    next.decisions.events.push(judgment);
    next.rules.push(rule('active', { exceptions: [...exceptions] }));
    const onApply = await openRules(next);
    expect(screen.getByText(expected)).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
  });

  it.each([
    ['candidate', rule('candidate'), '評価と人の有効化が終わっていない候補のため、利用しません。'],
    ['suspended', rule('suspended'), '停止中のため、利用しません。'],
    ['revoked', rule('revoked'), '撤回済みのため、利用しません。'],
    ['evidence_invalidated', rule('active'), '根拠に使った実例が撤回・変更されたため、利用しません。'],
    ['evaluation_invalidated', rule('active', { invalidEvaluation: true }), '評価に使った実例が撤回・変更されたため、利用しません。'],
  ] as const)('%sを利用可能と表示しない', async (kind, unavailableRule, expected) => {
    const next = empty();
    next.rules.push(unavailableRule);
    if (kind !== 'evidence_invalidated') next.decisions.events.push(judgment);
    const onApply = await openRules(next);
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText('利用できます。本文が完全に一致したときに提案の対象になります。')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
  });

  it('利用可能は提案資格であり、競合時は提案しないと説明する', async () => {
    const next = empty(); next.decisions.events.push(judgment); next.rules.push(rule());
    await openRules(next);
    expect(screen.getByText('利用可能なルールは、本文の条件に一致すると提案の対象になります。ルール同士が競合する場合は提案しません。')).toBeTruthy();
    expect(screen.queryByText(/適用済み|保存済み|必ず提案/)).toBeNull();
  });
});

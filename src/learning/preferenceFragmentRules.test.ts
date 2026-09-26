import {describe, expect, it} from 'vitest';
import {appendDecisionEvent, decisionEventSchema, emptyDecisionLedger} from './preferenceDecisions';
import {createRuleCandidate, preferenceRuleSchema, proposePreferenceEdits, replacePreferenceFragment, ruleAvailability, ruleEvidence} from './preferenceRules';
import {evaluatePreferenceRule, freezePreferenceDataset} from './preferenceEvaluation';
import {buildPreferenceModelInput, replayPreferenceAdapter, runPreferenceModelEvaluation} from './preferenceModelEvaluation';
import {PreferenceWorkspaceStore} from './preferenceWorkspaceStore';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Invented software-contract fixtures, never real consent or calibration evidence.
const example = (id: string, before: string, after: string) => {
 const parsed = decisionEventSchema.parse({
  schemaVersion: 1, type: 'judgment', editKind: 'telop_text', id, operationId: `op-${id}`,
  createdAt: '2026-09-09T00:00:00Z', actor: {kind: 'human', id: 'fictional-test-actor'},
  projectId: `training-${id}`, projectRevision: 'v1', elementId: 'caption',
  sourceFrameRange: {start: 0, end: 60}, before, proposedAfter: after, actualAfter: after,
  decision: 'accepted', reasonCode: 'wording', note: '', scope: {kind: 'profile', id: 'golf'},
  learningConsent: true, provenance: {kind: 'human'},
 });
 if (parsed.type !== 'judgment') throw new Error('Wrong fixture kind');
 return parsed;
};
const first = example('d1', '長いアイアソ2本ですね', '長いアイアン2本ですね');
const ledger = appendDecisionEvent(emptyDecisionLedger(), first);
const spec = {from: 'アイアソ', to: 'アイアン', exceptTextIncludes: ['引用：', '商品名は']};
const input = {id: 'rule', version: 1, evidenceIds: ['d1'], createdAt: '2026-09-09T00:01:00Z'};
const candidate = () => createRuleCandidate(ledger, {...input, fragment: spec});
const active = () => ({...candidate(), status: 'active' as const, activation: {
  actorId: 'fictional-test-actor', evaluationId: 'evaluation', at: '2026-09-09T00:02:00Z',
  dataset: {id: 'set', version: 1, hash: '0'.repeat(64)}, caseDependencies: [{decisionId: 'd1', operationId: 'op-d1'}],
}});
const target = (text: string, profileId = 'golf', projectId = 'new-project') => ({
  projectId, projectRevision: 'v2', profileId, elements: [{id: 'caption', text, sourceFrameRange: {start: 10, end: 50}}],
});

describe('明示した語句置換ルール', () => {
  it('全文一致の既存ルールを変えず、明示した語句条件だけを新形式にする', () => {
    expect(createRuleCandidate(ledger, input)).toMatchObject({schemaVersion: 1, conditions: {textEquals: first.before}});
    expect(candidate()).toMatchObject({schemaVersion: 2, status: 'candidate', conditions: {textIncludes: 'アイアソ', exceptTextIncludes: ['引用：', '商品名は']}, action: {kind: 'replace_occurrences', text: 'アイアン'}});
    expect(proposePreferenceEdits([candidate()], ledger, target('短いアイアソです')).proposals).toEqual([]);
  });
  it('別文章内の全出現だけを置換し、周辺の文章・範囲を保持する', () => {
    const result = proposePreferenceEdits([active()], ledger, target('アイアソを選びます。短いアイアソです。'));
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({before: 'アイアソを選びます。短いアイアソです。', after: 'アイアンを選びます。短いアイアンです。', sourceFrameRange: {start: 10, end: 50}});
  });
  it('指定した除外語句・別方針・例外案件では提案しない', () => {
    const r = active();
    for (const text of ['引用：『アイアソ』', '商品名はアイアソです', 'アイアンです']) expect(proposePreferenceEdits([r], ledger, target(text)).proposals).toEqual([]);
    expect(proposePreferenceEdits([r], ledger, target('アイアソです', 'other')).proposals).toEqual([]);
    expect(proposePreferenceEdits([{...r, exceptions: {projectIds: ['new-project']}}], ledger, target('アイアソです')).proposals).toEqual([]);
  });
  it('異なる文章の採用例も、同じ置換操作が完全に再現するときだけ根拠にできる', () => {
    const varied = appendDecisionEvent(ledger, example('d2', '短いアイアソです', '短いアイアンです'));
    const r = createRuleCandidate(varied, {...input, evidenceIds: ['d1', 'd2'], fragment: spec});
    expect(ruleEvidence(r, varied)).toHaveLength(2);
    expect(() => createRuleCandidate(ledger, {...input, fragment: {...spec, to: 'ウッド'}})).toThrow(/EVIDENCE_MISMATCH/);
    expect(() => createRuleCandidate(ledger, {...input, fragment: {...spec, exceptTextIncludes: ['長い']}})).toThrow(/EVIDENCE_MISMATCH/);
  });
  it('根拠への同意撤回後は履歴を保持して利用を止める', () => {
    const withdrawn = appendDecisionEvent(ledger, {schemaVersion: 1, type: 'withdrawal', id: 'w', operationId: 'w', createdAt: '2026-09-09T00:03:00Z', actor: {kind: 'human', id: 'fictional-test-actor'}, targetId: 'd1', reason: 'withdraw'});
    expect(ruleAvailability(active(), withdrawn)).toBe('evidence_invalidated');
    expect(proposePreferenceEdits([active()], withdrawn, target('短いアイアソです')).proposals).toEqual([]);
  });
  it('正規表現や置換テンプレートを解釈しない', () => {
    const l = appendDecisionEvent(emptyDecisionLedger(), example('d1', 'A.*B.*C', 'A$&B$&C'));
    const r = createRuleCandidate(l, {...input, fragment: {from: '.*', to: '$&', exceptTextIncludes: []}});
    expect(ruleEvidence(r, l)).toHaveLength(1);
  });
  it('空の語句と、条件・操作・保存形式の取り違えを拒否する', () => {
    expect(() => createRuleCandidate(ledger, {...input, fragment: {...spec, from: ''}})).toThrow();
    const r = candidate();
    expect(preferenceRuleSchema.safeParse({...r, schemaVersion: 1}).success).toBe(false);
    expect(preferenceRuleSchema.safeParse({...r, action: {kind: 'replace_text', text: 'アイアン'}}).success).toBe(false);
  });
  it('本文上限を超える展開を生成せず、上限内の絵文字を保持する', () => {
    expect(replacePreferenceFragment('a'.repeat(10000), {from: 'a', to: '長'.repeat(10000), exceptTextIncludes: []})).toBeNull();
    expect(replacePreferenceFragment('🏌️アイアソ🏌️', spec)).toBe('🏌️アイアン🏌️');
  });
  it('全文ルールと語句ルールの生成結果が違うときは競合として提案を止める', () => {
    const l = appendDecisionEvent(ledger, example('d2', '短いアイアソです', '短いクラブです'));
    const other = createRuleCandidate(l, {...input, id: 'exact', evidenceIds: ['d2']});
    const r = {...other, status: 'active' as const, activation: {...active().activation, caseDependencies: [{decisionId: 'd2', operationId: 'op-d2'}]}};
    const result = proposePreferenceEdits([active(), r], l, target('短いアイアソです'));
    expect(result.proposals).toEqual([]); expect(result.conflicts[0]?.rules).toHaveLength(2);
  });
  it('候補の語句条件と例外を再起動・書き出し後も保持し、再送や内容相違を区別する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'literal-rule-contract-'));
    try {
      const s = new PreferenceWorkspaceStore(dir);
      const base = {at: first.createdAt, actor: first.actor};
      s.execute({...base, operationId: 'profile', kind: 'profile', profileId: 'golf', name: 'Test only'});
      s.execute({...base, operationId: first.operationId, kind: 'decision', event: first});
      const command = {...base, operationId: 'candidate', kind: 'candidate', ruleId: 'rule', version: 1, evidenceIds: ['d1'], fragment: spec};
      s.execute(command);s.execute(command);
      const reopened = new PreferenceWorkspaceStore(dir).read();
      expect(reopened.rules).toHaveLength(1);expect(reopened.rules[0]).toEqual({...candidate(), createdAt: first.createdAt});
      expect(JSON.parse(s.export()).commands.at(-1).fragment).toEqual(spec);
      expect(() => s.execute({...command, fragment: {...spec, to: 'wood'}})).toThrow(/OPERATION_CONFLICT/);
    } finally {rmSync(dir, {recursive: true, force: true});}
  });
});

describe('語句条件を共有する決定的評価とモデル比較', () => {
  it('同じ実例・除外・本文一致で採点し、除外を無視したモデル出力を不合格にする', async () => {
    let l = ledger;
    const rows: [string, string | null][] = [
      ['短いアイアソです', '短いアイアンです'], ['アイアソを2本選ぶ', 'アイアンを2本選ぶ'],
      ['アイアソとアイアソ', 'アイアンとアイアン'], ['🏌️アイアソ', '🏌️アイアン'], ['アイアソ！', 'アイアン！'],
      ['引用：アイアソ', null], ['商品名はアイアソです', null], ['引用：短いアイアソ', null],
      ['商品名は長いアイアソ', null], ['アイアンです', null],
    ];
    rows.forEach(([before, after], i) => {
      const event = example(`held-${i}`, before, after ?? 'アイアン');
      l = appendDecisionEvent(l, {...event, decision: after === null ? 'rejected' : 'accepted', actualAfter: after});
    });
    const dataset = freezePreferenceDataset(l, {id: 'set', version: 1, caseIds: rows.map((_, i) => `held-${i}`), frozenAt: '2026-09-09T00:02:00Z'});
    const run = {id: 'run', startedAt: '2026-09-09T00:03:00Z'};
    const baseline = evaluatePreferenceRule(candidate(), l, dataset, run);
    expect(baseline.aggregate).toEqual({total: 10, passed: 10, falsePass: 0, falseFail: 0});
    expect(baseline.adapterVersion).toBe('literal-fragment-1');
    const packet = buildPreferenceModelInput(candidate(), dataset);
    expect(packet).toMatchObject({schemaVersion: 2, task: 'replace_telop_fragments', rule: {textIncludes: 'アイアソ', exceptTextIncludes: ['引用：', '商品名は']}});
    expect(JSON.stringify(packet)).not.toContain('actualAfter');
    const predictions = packet.cases.map((c, i) => ({caseId: c.caseId, after: rows[i]![1]}));
    const adapter = (output: unknown) => replayPreferenceAdapter({id: 'contract', version: '1', provider: 'fixture', model: 'fixture', output});
    const good = await runPreferenceModelEvaluation(candidate(), l, dataset, adapter({schemaVersion: 1, predictions}), run);
    expect(good.aggregate.passed).toBe(10);expect(good.activationAuthorized).toBe(false);
    const bad = await runPreferenceModelEvaluation(candidate(), l, dataset, adapter({schemaVersion: 1, predictions: predictions.map((p, i) => i === 5 ? {...p, after: '引用：アイアン'} : p)}), {...run, id: 'bad'});
    expect(bad.aggregate.ruleViolations).toBe(1);expect(bad.results[5]?.passed).toBe(false);
    expect(bad.activationAuthorized).toBe(false);
  });
});

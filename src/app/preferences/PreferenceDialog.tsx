import { useEffect, useMemo, useRef, useState } from 'react';
import type { DecisionEvent, JudgmentExample } from '../../learning/preferenceDecisions';
import { eligibleDecisionExamples } from '../../learning/preferenceDecisions';
import { ruleAvailability, type PreferenceProposal, type PreferenceRule, type PreferenceTarget } from '../../learning/preferenceRules';
import { FragmentRuleForm } from './FragmentRuleForm';
import type { PreferenceCommand } from '../../learning/preferenceWorkspaceStore';
import { editorReviewProposal, type EditorReviewTarget } from '../../shared/editorReview';
import { useDialogEscape } from '../useDialogEscape';
import { useFocusTrap } from '../useFocusTrap';
import { putJsonPost } from '../fetchJson';
import { preferenceCommandBase, usePreferenceWorkspace } from '../usePreferenceWorkspace';
import { ModelComparisonPanel } from './ModelComparisonPanel';
import { ScriptEvaluationPanel } from './ScriptEvaluationPanel';
import './preferences.css';

type View = 'edit' | 'rules' | 'records' | 'script';
interface Props {
  projectId: string;
  projectName: string;
  selectedElementId: string | null;
  getTarget: () => Omit<PreferenceTarget, 'profileId'>;
  onApply: (proposal: PreferenceProposal, after: string, validateRule: boolean) => Promise<void>;
  onClose: () => void;
  initialReview?: EditorReviewTarget | null;
}
const DECISIONS: Record<JudgmentExample['decision'], string> = {
  accepted: '採用', accepted_modified: '直して採用', rejected: '却下', deferred: '後で判断',
};
const REASONS: Record<JudgmentExample['reasonCode'], string> = {
  unspecified: '指定しない', wording: 'いつもの言い方にする', factual_correction: '内容を正しくする', tone: '口調をそろえる',
  readability: '読みやすくする', context_mismatch: 'この文脈には合わない', one_off: '今回だけの調整', other: 'その他',
};
const FAILURES: Record<string, string> = {
  HUMAN_LABELS_REQUIRED: '人が判断した実例が必要です', INSUFFICIENT_CASES: '評価用の実例は10件以上必要です',
  INSUFFICIENT_HELDOUT_PROJECTS: '評価には別々の動画2本以上が必要です',
  TRAIN_EVAL_PROJECT_OVERLAP: '候補づくりと評価に同じ動画が含まれています',
  POSITIVE_AND_NEGATIVE_REQUIRED: '採用例と却下例の両方が必要です',
  EVIDENCE_INVALIDATED: '根拠の実例が変更・撤回されています', CASE_INVALIDATED: '評価の実例が変更・撤回されています',
  FALSE_PASS: '望まない提案が出ています', FALSE_FAIL: '必要な提案が出ていません',
  UNJUDGED_ALTERNATIVE: '人がまだ判断していない別案があります', RULE_REVOKED: 'この版は撤回されています',
};
type RuleAvailability = ReturnType<typeof ruleAvailability>;
const RULE_STATUSES: Record<RuleAvailability, string> = {
  available: '有効', candidate: '候補', suspended: '停止中', revoked: '撤回済み',
  evidence_invalidated: '根拠が撤回されたため停止', evaluation_invalidated: '評価の実例が変更されたため停止',
};
const UNAVAILABLE_REASONS: Record<Exclude<RuleAvailability, 'available'>, string> = {
  candidate: '評価と人の有効化が終わっていない候補のため、利用しません。',
  suspended: '停止中のため、利用しません。', revoked: '撤回済みのため、利用しません。',
  evidence_invalidated: '根拠に使った実例が撤回・変更されたため、利用しません。',
  evaluation_invalidated: '評価に使った実例が撤回・変更されたため、利用しません。',
};

function projectAvailabilityMessage(rule: PreferenceRule, availability: RuleAvailability, projectId: string, profileId: string | null): string {
  if (profileId === null) return '編集方針が未指定のため、利用しません。';
  if (rule.scope.id !== profileId) return 'この動画の編集方針とは異なるため、利用しません。';
  if (rule.exceptions.projectIds.includes(projectId)) return 'この動画は例外に指定されているため、利用しません。';
  if (availability === 'available') return 'textEquals' in rule.conditions
    ? '利用できます。本文が完全に一致したときに提案の対象になります。'
    : '利用できます。指定した語句を含み、除外の目印を含まない字幕で提案の対象になります。';
  return UNAVAILABLE_REASONS[availability];
}

export function PreferenceDialog({ projectId, projectName, selectedElementId, getTarget, onApply, onClose, initialReview }: Props) {
  const workspace = usePreferenceWorkspace();
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>('edit');
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [localError, setLocalError] = useState('');
  const [profileName, setProfileName] = useState('');
  const [selectedCases, setSelectedCases] = useState<string[]>([]);
  const [datasetKey, setDatasetKey] = useState('');
  const [proposals, setProposals] = useState<PreferenceProposal[]>([]);
  const [conflicts, setConflicts] = useState(0);
  const [activeProposal, setActiveProposal] = useState<PreferenceProposal | null>(null);
  const [after, setAfter] = useState(initialReview?.change.after ?? '');
  const [modifiedAfter, setModifiedAfter] = useState(initialReview?.change.after ?? '');
  const [reviewCompleted, setReviewCompleted] = useState(false);
  const [reason, setReason] = useState<JudgmentExample['reasonCode']>('unspecified');
  const [note, setNote] = useState('');
  const [consent, setConsent] = useState(false);
  const [restore, setRestore] = useState<unknown>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [fragmentSourceId, setFragmentSourceId] = useState<string | null>(null);
  const state = workspace.state;
  const locked = working || workspace.busy || workspace.pending !== null;
  useDialogEscape(onClose, !locked);
  useFocusTrap(root);
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  const target = getTarget();
  const selected = target.elements.find((e) => e.id === (initialReview?.change.elementId ?? selectedElementId)) ?? null;
  const [manualBase, setManualBase] = useState(() => selected ? { ...selected, projectRevision: target.projectRevision } : null);
  const profileId = state?.projectProfiles[projectId] ?? null;
  const profile = state?.profiles.find((p) => p.id === profileId);
  const examples = useMemo(() => state ? eligibleDecisionExamples(state.decisions, { includeSynthetic: true }) : [], [state]);
  const judgments = state?.decisions.events.filter((e): e is JudgmentExample => e.type === 'judgment') ?? [];
  const ruleDataset = state?.datasets.find((d) => `${d.id}:${d.version}` === datasetKey);
  const source = initialReview ? { id: initialReview.change.elementId, text: initialReview.change.before,
    sourceFrameRange: initialReview.change.sourceFrameRange, projectRevision: initialReview.baseRevision }
    : activeProposal ? { id: activeProposal.elementId, text: activeProposal.before,
    sourceFrameRange: activeProposal.sourceFrameRange, projectRevision: activeProposal.projectRevision } : manualBase;

  async function action(task: () => Promise<unknown>, success?: string) {
    if (locked) return;
    setWorking(true); setNotice(''); setLocalError('');
    try { await task(); if (success) setNotice(success); }
    catch (e) { setLocalError(e instanceof Error ? e.message : String(e)); }
    finally { setWorking(false); }
  }
  const command = (input: PreferenceCommand) => workspace.execute(input);
  async function loadProposals() {
    const result = await putJsonPost<{ proposals: PreferenceProposal[]; conflicts: unknown[] }>('/api/preferences/proposals', getTarget());
    setProposals(result.proposals); setConflicts(result.conflicts.length);
    setActiveProposal(null); setAfter(''); setModifiedAfter('');
  }
  function pickProposal(p: PreferenceProposal) {
    setActiveProposal(p); setAfter(p.after); setModifiedAfter(p.after); setConsent(false); setNotice('');
  }
  function completeDecision(elementId: string, message: string, completedProposalId?: string) {
    if (initialReview) {
      if (completedProposalId !== initialReview.proposalId || elementId !== initialReview.change.elementId) {
        setLocalError(''); setNotice(message); return;
      }
      setReviewCompleted(true); setConsent(false); setLocalError(''); setNotice(message); return;
    }
    const currentTarget = getTarget();
    const currentElement = currentTarget.elements.find((e) => e.id === elementId);
    setManualBase(currentElement ? { ...currentElement, projectRevision: currentTarget.projectRevision } : null);
    setAfter(''); setModifiedAfter(''); setReason('unspecified'); setNote(''); setConsent(false);
    setActiveProposal(null); setProposals([]); setConflicts(0); setLocalError(''); setNotice(message);
  }
  async function decide(decision: JudgmentExample['decision']) {
    if (reviewCompleted) return;
    if (!source || !after.trim()) throw new Error('見直したい字幕と提案する本文を指定してください');
    if (consent && !profileId) throw new Error('今後の好みに使うには、先にこの動画の編集方針を選んでください');
    if (reason === 'other' && !note.trim()) throw new Error('その他の理由を入力してください');
    const actualAfter = decision === 'accepted' ? after : decision === 'accepted_modified' ? modifiedAfter : null;
    if (decision === 'accepted_modified' && (!modifiedAfter.trim() || modifiedAfter === after)) throw new Error('直して採用する本文を、元の提案とは別に入力してください');
    const base = preferenceCommandBase();
    const priorReview = initialReview ? judgments.filter((event) => event.proposalId === initialReview.proposalId
      && event.projectId === projectId && event.elementId === source.id).at(-1) : undefined;
    const proposal: PreferenceProposal = activeProposal ?? { projectId, projectRevision: source.projectRevision,
      elementId: source.id, before: source.text, after, sourceFrameRange: source.sourceFrameRange,
      rule: { id: 'manual', version: 1 }, evidenceIds: [] };
    if (initialReview && (actualAfter !== null || decision === 'rejected')) {
      if (!manualBase) throw new Error('REVIEW_TARGET_CHANGED: 現在の字幕がありません');
      const currentProposal = editorReviewProposal(initialReview, { projectId,
        projectRevision: manualBase.projectRevision, elements: [manualBase] });
      await onApply(currentProposal, decision === 'rejected' ? initialReview.change.before : actualAfter!, false);
    } else if (actualAfter !== null) await onApply(proposal, actualAfter, activeProposal !== null);
    const event: DecisionEvent = { schemaVersion: 1, id: crypto.randomUUID(), type: 'judgment', editKind: 'telop_text',
      operationId: base.operationId, createdAt: base.at, actor: base.actor, projectId, projectRevision: proposal.projectRevision,
      elementId: proposal.elementId, sourceFrameRange: proposal.sourceFrameRange, before: proposal.before,
      proposedAfter: after, actualAfter, decision, reasonCode: reason, note, learningConsent: consent,
      scope: consent && profileId ? { kind: 'profile', id: profileId } : { kind: 'project', id: projectId },
      provenance: { kind: workspace.recordingProvenance }, ...(activeProposal ? { rule: activeProposal.rule } : {}),
      ...(initialReview ? { proposalId: initialReview.proposalId } : {}), ...(priorReview ? { supersedes: priorReview.id } : {}) };
    await command({ ...base, kind: 'decision', event });
    completeDecision(proposal.elementId, initialReview && decision === 'rejected'
      ? '変更前の本文に戻し、却下を記録しました。字幕の変更は保存ボタンで保存できます。'
      : actualAfter === null ? '判断を記録しました。字幕は変えていません。' : '字幕を確認し、判断を記録しました。編集の保存と取り消しは、いつもの操作を使えます。', initialReview?.proposalId);
  }

  return <div className="preference-overlay">
    <div ref={root} className="preference-dialog" role="dialog" aria-modal="true" aria-labelledby="preference-title" data-testid="preference-dialog">
      <header className="preference-header"><div><p className="preference-eyebrow">{projectName}</p><h2 id="preference-title">編集の好み</h2>
        <p>今回の修正と、これからの好みを分けて残します。</p></div>
        <button type="button" onClick={onClose} disabled={locked} aria-label="編集の好みを閉じる">閉じる</button></header>
      <nav className="preference-nav" aria-label="編集の好みの表示">
        {([['edit', '字幕を見直す'], ['rules', '好みのルール'], ['records', '判断の記録'], ['script', '台本の比較']] as const).map(([key, label]) =>
          <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)} disabled={locked}>{label}</button>)}
      </nav>
      <div className="preference-body" aria-busy={working || workspace.busy}>
        {workspace.recordingProvenance === 'synthetic' && <p className="preference-notice">検証用の画面です。ここで作る実例は合成例として保存し、人による評価やルールの有効化には使いません。</p>}
        {(localError || workspace.error) && <div className="preference-error" role="alert">{localError || workspace.error}</div>}
        {notice && <p className="preference-notice" role="status">{notice}</p>}
        {workspace.pending && !workspace.busy && <button type="button" onClick={() => {
          const pending = workspace.pending;
          if (pending === null) return;
          void workspace.retry().then(() => {
            if (pending.kind === 'decision' && pending.event.type === 'judgment' && pending.event.projectId === projectId) {
              completeDecision(pending.event.elementId, '記録の保存を確認しました。', pending.event.proposalId);
            } else {
              setLocalError(''); setNotice('記録の保存を確認しました。');
            }
          }).catch(() => {});
        }}>同じ記録の保存を再確認</button>}
        {!state && <p>好みの記録を読み込んでいます…</p>}
        {state && <>
          <section className="preference-profile" aria-label="この動画の編集方針">
            <label>この動画の編集方針<select value={profileId ?? ''} disabled={locked} onChange={(e) => {
              const next = e.target.value || null;
              void action(async () => { await command({ ...preferenceCommandBase(), kind: 'assign', projectId, profileId: next });
                setConsent(false); setProposals([]); setActiveProposal(null); }, 'この動画の編集方針を変更しました。');
            }}><option value="">指定しない（今回の修正だけ）</option>{state.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <details><summary>編集方針を作る</summary><div className="preference-inline"><label>名前<input value={profileName} maxLength={80} placeholder="例：ゴルフ解説" onChange={(e) => setProfileName(e.target.value)} /></label>
              <button type="button" disabled={locked || !profileName.trim()} onClick={() => void action(async () => {
                const newId = crypto.randomUUID(); await command({ ...preferenceCommandBase(), kind: 'profile', profileId: newId, name: profileName });
                await command({ ...preferenceCommandBase(), kind: 'assign', projectId, profileId: newId }); setProfileName('');
              }, '編集方針を作り、この動画に設定しました。')}>作成して使う</button></div></details>
          </section>
          {view === 'edit' && <section>
            {!initialReview && <><div className="preference-section-title"><h3>この動画への提案</h3><button type="button" disabled={locked || !profileId} onClick={() => void action(loadProposals)}>提案を更新</button></div>
            <p>有効にしたルールだけを使います。提案を見るだけでは字幕は変わりません。</p></>}
            {conflicts > 0 && <p role="status">異なる好みが重なる字幕が{conflicts}件あります。自動で選ばず、提案を保留しています。</p>}
            {proposals.length > 0 && <ul className="preference-proposals">{proposals.map((p) => <li key={`${p.elementId}:${p.rule.id}`}><button type="button" disabled={locked} onClick={() => pickProposal(p)}>
              <span>{p.before}</span><strong>→ {p.after}</strong><small>第{p.rule.version}版・根拠{p.evidenceIds.length}件</small></button></li>)}</ul>}
            <h3>{initialReview ? 'AIの変更を判断する' : activeProposal ? '提案を確認する' : '選択中の字幕を見直す'}</h3>
            {initialReview && <p>現在の字幕：{manualBase?.text ?? '削除されています'}<br />採用するとAIの案に、却下して戻すと変更前の本文になります。後で判断する場合は字幕を変えません。</p>}
            {!source ? <p>この画面を閉じ、文字起こしから字幕を選ぶと見直せます。</p> : <>
              <div className="preference-comparison"><label>{initialReview ? '変更前の本文' : '今の本文'}<div className="preference-before">{source.text}</div></label>
                <label>提案する本文<textarea aria-label="提案する本文" value={after} maxLength={10000} disabled={locked || activeProposal !== null || !!initialReview} onChange={(e) => { setAfter(e.target.value); setModifiedAfter(e.target.value); }} /></label></div>
              <details><summary>提案をさらに直して採用する</summary><label>直して採用する本文<textarea aria-label="直して採用する本文" value={modifiedAfter} maxLength={10000} disabled={locked} onChange={(e) => setModifiedAfter(e.target.value)} /></label></details>
              <div className="preference-inline"><label>判断の理由<select value={reason} disabled={locked} onChange={(e) => setReason(e.target.value as JudgmentExample['reasonCode'])}>
                {Object.entries(REASONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
                <label>補足{reason !== 'other' && '（任意）'}<input value={note} maxLength={4000} disabled={locked} onChange={(e) => setNote(e.target.value)} /></label></div>
              <label className="preference-consent"><input type="checkbox" checked={consent} disabled={locked || !profileId} onChange={(e) => setConsent(e.target.checked)} />
                <span>この判断を今後の好みに使う<small>{profile ? `「${profile.name}」の実例として残します。有効化は別の操作です。` : '編集方針を選ぶと、今後の好みにも使えます。'}</small></span></label>
            </>}
          </section>}
          {view === 'rules' && <section>
            <h3>候補 → 評価 → 人が有効化</h3><p>同じ修正を繰り返しても、自動で有効にはしません。評価用の実例は「判断の記録」で選べます。</p>
            <p>利用可能なルールは、本文の条件に一致すると提案の対象になります。ルール同士が競合する場合は提案しません。</p>
            <label>固定した評価データ<select value={datasetKey} disabled={locked} onChange={(e) => setDatasetKey(e.target.value)}><option value="">評価データを選ぶ</option>
              {state.datasets.map((d) => <option key={`${d.id}:${d.version}`} value={`${d.id}:${d.version}`}>{d.cases.length}件・第{d.version}版・{new Date(d.frozenAt).toLocaleDateString('ja-JP')}</option>)}</select></label>
            {state.rules.length === 0 && <div className="preference-empty">まだルール候補はありません。今後の好みに使う採用例を「判断の記録」から候補にできます。</div>}
            {state.rules.map((rule) => {
              const availability = ruleAvailability(rule, state.decisions);
              const evaluation = [...state.evaluations].reverse().find((e) => e.rule.id === rule.id && e.rule.version === rule.version);
              const status = RULE_STATUSES[availability];
              return <article className="preference-rule" key={`${rule.id}:${rule.version}`}><div className="preference-section-title"><strong>{status}・第{rule.version}版</strong><span>根拠 {rule.evidenceIds.length}件</span></div>
                {'textEquals' in rule.conditions
                  ? <p>「{rule.conditions.textEquals}」と完全に一致するとき<br />「{rule.action.text}」を提案</p>
                  : <><p>字幕内の「{rule.conditions.textIncludes}」をすべて「{rule.action.text}」へ置換する提案</p>
                    <p>使わない字幕の目印：{rule.conditions.exceptTextIncludes.length ? rule.conditions.exceptTextIncludes.map((s) => `「${s}」`).join('、') : '指定なし'}</p>
                    <small>目印を含む字幕全体を除外します。文脈を自動で見分ける条件ではありません。</small></>}
                <p>対象：{state.profiles.find((p) => p.id === rule.scope.id)?.name ?? '編集方針'} ／ 例外の動画：{rule.exceptions.projectIds.length}本</p>
                <p><strong>この動画：</strong><span>{projectAvailabilityMessage(rule, availability, projectId, profileId)}</span></p>
                {evaluation && <div className="preference-evaluation"><strong>{evaluation.activationEligible ? '固定した実例の検証に合格' : '有効化には追加の確認が必要です'}</strong>
                  <p>{evaluation.aggregate.passed} / {evaluation.aggregate.total}件が一致。望まない提案 {evaluation.aggregate.falsePass}件、必要な提案の不足 {evaluation.aggregate.falseFail}件。</p>
                  {evaluation.failures.length > 0 && <ul>{evaluation.failures.map((failure) => <li key={failure}>{FAILURES[failure] ?? '評価の詳細を確認してください'}</li>)}</ul>}
                  <small>本文の完全一致を調べた結果です。表現全般の品質や、別モデルの品質を保証するものではありません。</small></div>}
                <div className="preference-actions"><button type="button" disabled={locked || !ruleDataset || rule.status === 'revoked'} onClick={() => void action(() => command({ ...preferenceCommandBase(), kind: 'evaluate', ruleId: rule.id, version: rule.version, datasetId: ruleDataset!.id, datasetVersion: ruleDataset!.version }))}>評価する</button>
                  <button type="button" className="preference-primary" disabled={locked || !ruleDataset || !evaluation?.activationEligible || rule.status === 'revoked' || rule.status === 'active'} onClick={() => void action(() => command({ ...preferenceCommandBase(), kind: 'activate', ruleId: rule.id, version: rule.version, datasetId: ruleDataset!.id, datasetVersion: ruleDataset!.version }), 'ルールを有効にしました。次の動画にも同じ編集方針を設定すると提案を受け取れます。')}>確認して有効にする</button>
                  {rule.status !== 'revoked' && <button type="button" disabled={locked} onClick={() => void action(() => command({ ...preferenceCommandBase(), kind: 'status', ruleId: rule.id, version: rule.version, status: 'revoked' }), 'ルールを撤回しました。過去に保存した字幕は変わりません。')}>このルールを撤回</button>}</div>
                {ruleDataset && <ModelComparisonPanel key={`${rule.id}:${rule.version}:${datasetKey}:${state.operations.length}`}
                  selection={{ ruleId: rule.id, ruleVersion: rule.version, datasetId: ruleDataset.id, datasetVersion: ruleDataset.version }}
                  disabled={locked || rule.status === 'revoked'} />}
              </article>;
            })}
          </section>}
          {view === 'script' && <ScriptEvaluationPanel workspace={workspace} disabled={locked} />}
          {view === 'records' && <section>
            <h3>採用した例も、却下した例も残す</h3><p>評価には、候補の根拠とは別の動画の実例を選びます。保留・同意なし・撤回した記録は評価に使いません。</p>
            <div className="preference-actions"><button type="button" disabled={locked || selectedCases.length === 0} onClick={() => void action(async () => {
              const datasetId = crypto.randomUUID(); await command({ ...preferenceCommandBase(), kind: 'dataset', datasetId, datasetVersion: 1, caseIds: selectedCases });
              setDatasetKey(`${datasetId}:1`); setSelectedCases([]); setView('rules');
            }, '評価する実例を固定しました。候補を選んで評価できます。')}>選んだ{selectedCases.length}件を評価用に固定</button><a href="/api/preferences/export" download>記録を書き出す</a></div>
            {judgments.length === 0 && <div className="preference-empty">まだ判断の記録はありません。「字幕を見直す」から最初の実例を残せます。</div>}
            {judgments.map((e) => {
              const eligible = examples.some((example) => example.id === e.id);
              return <article className="preference-record" key={e.id}><div className="preference-section-title"><strong>{DECISIONS[e.decision]}</strong><span>{e.projectId === projectId ? 'この動画' : e.projectId}</span></div>
                <p>{e.before} → {e.proposedAfter}</p>{e.decision === 'accepted_modified' && <p>実際に採用：{e.actualAfter}</p>}
                <p>{REASONS[e.reasonCode]}{e.note ? `：${e.note}` : ''}</p><small>{e.learningConsent ? eligible ? '今後の好みに使える実例' : '撤回・訂正・保留などにより学習対象外' : '今回の判断だけ'} ／ {e.provenance.kind === 'synthetic' ? '合成例' : e.provenance.kind === 'model' ? 'モデル由来' : '人の判断として記録'}</small>
                <div className="preference-actions"><label><input type="checkbox" checked={selectedCases.includes(e.id)} disabled={locked || !eligible} onChange={(event) => setSelectedCases((prev) => event.target.checked ? [...prev, e.id] : prev.filter((key) => key !== e.id))} />評価用に選ぶ</label>
                  <button type="button" disabled={locked || !eligible || e.actualAfter === null || e.scope.kind !== 'profile' || e.provenance.kind === 'synthetic'} onClick={() => void action(async () => {
                    await command({ ...preferenceCommandBase(), kind: 'candidate', ruleId: crypto.randomUUID(), version: 1, evidenceIds: [e.id] }); setView('rules');
                  }, '候補を作りました。評価と人の有効化が終わるまでは提案に使いません。')}>ルール候補にする</button>
                  <button type="button" disabled={locked || !eligible || e.actualAfter === null || e.scope.kind !== 'profile' || e.provenance.kind === 'synthetic'} onClick={() => setFragmentSourceId(e.id)}>語句のルールにする</button>
                  {eligible && <button type="button" disabled={locked} onClick={() => void action(async () => {
                    const base = preferenceCommandBase(); await command({ ...base, kind: 'decision', event: { schemaVersion: 1, type: 'withdrawal', id: crypto.randomUUID(),
                      operationId: base.operationId, createdAt: base.at, actor: base.actor, targetId: e.id, reason: '編集の好み画面で同意を撤回' } });
                    setSelectedCases((prev) => prev.filter((key) => key !== e.id)); setProposals([]);
                  }, '今後の学習への同意を撤回しました。字幕の編集結果は変わりません。')}>学習への同意を撤回</button>}</div>
                {fragmentSourceId === e.id && e.actualAfter !== null && <FragmentRuleForm key={e.id} before={e.before} after={e.actualAfter}
                  disabled={locked || !eligible || e.provenance.kind === 'synthetic'} onCancel={() => setFragmentSourceId(null)}
                  onCreate={(fragment) => void action(async () => {
                    await command({...preferenceCommandBase(), kind: 'candidate', ruleId: crypto.randomUUID(), version: 1, evidenceIds: [e.id], fragment});
                    setFragmentSourceId(null); setView('rules');
                  }, '語句の候補を保存しました。評価と人の有効化が終わるまでは提案に使いません。')} />}
              </article>;
            })}
            <details className="preference-restore"><summary>書き出した記録を戻す</summary><p>判断・評価・ルールの有効状態を含めて、この端末へ復元します。既存記録と食い違う内容は上書きしません。</p>
              <input type="file" accept="application/json,.json" aria-label="戻す好みの記録" disabled={locked} onChange={(e) => {
                const file = e.target.files?.[0]; if (!file) return; setRestoreConfirmed(false); setRestore(null);
                void action(async () => { setRestore(JSON.parse(await file.text())); }, '記録を読み込みました。復元する内容の扱いを確認してください。');
              }} /><label className="preference-consent"><input type="checkbox" checked={restoreConfirmed} onChange={(e) => setRestoreConfirmed(e.target.checked)} disabled={locked || restore === null} />有効なルールも含めて復元する</label>
              <button type="button" disabled={locked || restore === null || !restoreConfirmed} onClick={() => void action(async () => {
                await putJsonPost('/api/preferences/import', { confirmedRestore: true, journal: restore }); await workspace.refresh(); setRestore(null); setRestoreConfirmed(false);
              }, '記録を復元しました。')}>この端末へ復元</button>
            </details>
          </section>}
        </>}
      </div>
      <footer className="preference-footer">
        {view === 'edit' && source && <div className="preference-actions">{(Object.keys(DECISIONS) as JudgmentExample['decision'][]).map((decision) => <button type="button" key={decision}
          className={decision === 'accepted' ? 'preference-primary' : ''} disabled={locked || !after.trim() || reviewCompleted}
          onClick={() => void action(() => decide(decision))}>{initialReview && decision === 'rejected' ? '却下して戻す' : DECISIONS[decision]}</button>)}</div>}
        <p>好みの記録はこの端末に保存されます。字幕の修正だけで、学習への同意が付くことはありません。</p>
      </footer>
    </div>
  </div>;
}

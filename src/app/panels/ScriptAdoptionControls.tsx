import { useState } from 'react';
import type { ScriptEditModification } from '../../core/scriptEditModification';
import { isScriptAdoptionDecision } from '../edit/scriptAdoption';
import { ScriptModificationEditor } from './ScriptModificationEditor';
import { ScriptOperationDetails } from './ScriptOperationDetails';
import type { ScriptEditArtifact } from '../../core/scriptEditArtifact';
import { useScriptAdoption, type ScriptAdoptionBridge, type ScriptDecisionInput } from '../useScriptAdoption';

export interface ScriptAdoptionAccess { bridge: ScriptAdoptionBridge; onOpenActivity: () => void; connectionReady?: boolean }
const reasons: Record<ScriptDecisionInput['reasonCode'], string> = {
  unspecified: '理由は未入力', wording: '表記・言葉遣い', meaning: '意味・内容', timing: '発話のタイミング',
  take_selection: '使うテイク', structure: '話の構成', readability: '読みやすさ', one_off: '今回だけの判断', other: 'その他',
};
const decisions = { accepted: '採用', accepted_modified: '直して採用', rejected: '却下', deferred: '保留' };
const phases = { queued: '編集への反映を待っています', running: '編集に反映しています', applied: '反映済み・保存を確認中です',
  saved: '編集に反映し、保存しました', failed: '編集を完了できませんでした', cancelled: '編集の停止を記録しました', unknown: '編集・保存の結果を確認する必要があります' };

export function ScriptAdoptionControls({ artifact, bridge, onOpenActivity, disabled, isCurrent, connectionReady = true }: ScriptAdoptionAccess & {
  artifact: ScriptEditArtifact; disabled: boolean; isCurrent: () => boolean;
}) {
  const adoption = useScriptAdoption(artifact, bridge, isCurrent);
  const { workspace, judgment, operation } = adoption;
  const [reasonCode, setReason] = useState<ScriptDecisionInput['reasonCode']>('unspecified');
  const [note, setNote] = useState('');
  const [learningConsent, setConsent] = useState(false);
  const [editingModification, setEditingModification] = useState(false);
  const [modification, setModification] = useState<ScriptEditModification | null>(null);
  const busy = adoption.working || workspace.busy;
  const locked = disabled || busy || !workspace.state || !!workspace.pending;
  const withdrawn = !!judgment && !!workspace.state?.decisions.events.some(e => e.type === 'withdrawal' && e.targetId === judgment.id);
  const events = workspace.state?.decisions.events.filter(e => e.type === 'script_judgment'
    && e.artifact.proposal.proposalId === artifact.proposal.proposalId && e.projectId === artifact.input.alignment.packet.projectId
    && JSON.stringify(e.artifact) === JSON.stringify(artifact)) ?? [];
  const submit = (decision: ScriptDecisionInput['decision']) => {
    if (decision === 'accepted_modified' && !modification) return;
    void adoption.decide({ decision, reasonCode, note, learningConsent,
      ...(decision === 'accepted_modified' && modification ? { modification } : {}) });
  };
  return <section className="script-adoption" aria-label="変更案への判断" data-testid="script-adoption" aria-busy={busy}>
    <h4>この変更案をどうしますか</h4>
    {workspace.recordingProvenance === 'synthetic' && <p className="script-stage-note">検証用の画面です。ここでの判断は人の学習データに含めません。</p>}
    {!disabled && !connectionReady && <p className="script-stage-note" role="status">編集内容の同期を待っています。接続が整うと、採用内容を反映できます。</p>}
    {(adoption.error || workspace.error) && <p role="alert" className="script-error">{adoption.error || workspace.error}</p>}
    {workspace.pending && <button className="btn-secondary" disabled={busy} onClick={() => { void adoption.retryRecording(); }}>記録の保存を再確認</button>}
    {judgment && <div className="script-decision-status" role="status">
      <p>判断：{decisions[judgment.decision]}を記録済み</p>
      {isScriptAdoptionDecision(judgment.decision) && <>
        <p>{operation ? phases[operation.phase] : '編集への反映はまだ確認できていません。'}</p>
        {(!operation || operation.phase === 'queued') && judgment.application && <button className="btn-secondary" disabled={locked || !connectionReady} onClick={() => { void adoption.retryApplication(); }}>同じ採用内容で反映を再確認</button>}
        {operation && ['failed', 'cancelled', 'unknown'].includes(operation.phase) && <button className="btn-secondary" onClick={onOpenActivity}>編集と保存の結果を確認</button>}
      </>}
      <small>{withdrawn ? '学習への同意を撤回済みです。編集結果は変わりません。' : judgment.learningConsent ? '学習への利用に同意済み。保留や保存未確認の採用は学習に使いません。' : '学習への利用には同意していません。'}</small>
      {judgment.learningConsent && !withdrawn && <button className="btn-secondary" disabled={busy || !!workspace.pending} onClick={() => { setConsent(false); void adoption.withdrawConsent(); }}>学習への同意を撤回</button>}
    </div>}
    {!isScriptAdoptionDecision(judgment?.decision) && <>
      {editingModification ? <>
        <ScriptModificationEditor artifact={artifact} disabled={locked} onChange={setModification} />
        <button className="btn-secondary" disabled={locked} onClick={() => { setEditingModification(false); setModification(null); }}>修正を取り消す</button>
      </> : <button className="btn-secondary" disabled={locked} onClick={() => setEditingModification(true)}>提案を直して採用する</button>}
      <label>判断の理由（任意）<select value={reasonCode} disabled={locked} onChange={event => setReason(event.target.value as ScriptDecisionInput['reasonCode'])}>
        {Object.entries(reasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>補足（任意）<textarea value={note} maxLength={4000} disabled={locked} onChange={event => setNote(event.target.value)} placeholder="今回の意図や、残しておきたい判断の理由" /></label>
      <label className="script-learning-consent"><input type="checkbox" checked={learningConsent} disabled={locked} onChange={event => setConsent(event.target.checked)} />この判断を今後の編集ルールの検証に使う</label>
      <p className="script-stage-note">採用すると、表示中の変更案をまとめて反映・保存します。編集は「元に戻す」で戻せます。却下・保留では編集は変わりません。</p>
      <div className="script-adoption-actions">
        {editingModification
          ? <button className="btn-primary" disabled={locked || !connectionReady || !modification} onClick={() => submit('accepted_modified')}>直して採用して反映</button>
          : <button className="btn-primary" disabled={locked || !connectionReady} onClick={() => submit('accepted')}>採用して反映</button>}
        <button className="btn-secondary" disabled={locked} onClick={() => submit('rejected')}>却下</button>
        <button className="btn-secondary" disabled={locked} onClick={() => submit('deferred')}>保留</button>
      </div>
      {judgment && <p className="script-stage-note">再判断は、前の判断を残して訂正として記録します。</p>}
    </>}
    {events.length > 0 && <details className="script-judgment-history"><summary>この案への判断履歴（{events.length}件）</summary>
      <ol>{events.map(event => event.type === 'script_judgment' && <li key={event.id}>
        <span>{decisions[event.decision]} · {new Date(event.createdAt).toLocaleString('ja-JP')}{event.id !== judgment?.id ? '（過去の判断）' : ''}</span>
        <p>{reasons[event.reasonCode]}{event.note ? `：${event.note}` : ''}</p>
        {event.modification && <ScriptOperationDetails artifact={event.artifact} modification={event.modification} />}
      </li>)}</ol></details>}
  </section>;
}

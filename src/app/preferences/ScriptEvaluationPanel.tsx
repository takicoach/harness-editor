import { useEffect, useRef, useState } from 'react';
import type { ScriptDecisionAvailability, ScriptEvaluationDataset } from '../../learning/scriptEvaluation';
import { fetchJson, putJsonPost } from '../fetchJson';
import { preferenceCommandBase, type usePreferenceWorkspace } from '../usePreferenceWorkspace';
import { ScriptOperationDetails } from '../panels/ScriptOperationDetails';
import { ScriptModelComparisonPanel } from './ScriptModelComparisonPanel';

type Workspace = ReturnType<typeof usePreferenceWorkspace>;
export interface ScriptEvaluationState {
  cases: ScriptDecisionAvailability[];
  datasets: Array<{ dataset: ScriptEvaluationDataset; available: boolean; reason: string | null }>;
  syntheticWorkspace: boolean;
}
const decisions = { accepted: '採用', accepted_modified: '直して採用', rejected: '却下', deferred: '保留' };
const reasons: Record<string, string> = {
  NO_LEARNING_CONSENT: '学習への利用に同意していません', DEFERRED: '判断を保留しています',
  SUPERSEDED: '後の判断で訂正されています', WITHDRAWN: '利用への同意を撤回しています',
  HUMAN_LABEL_REQUIRED: '人による判断が必要です', SYNTHETIC_NOT_ALLOWED: '合成例は通常の評価に使いません',
  SAVE_RECEIPT_REQUIRED: '採用内容の保存が未確認です', SAVE_RECEIPT_MISMATCH: '採用内容と保存記録が一致しません',
};

export function ScriptEvaluationPanel({ workspace, disabled }: { workspace: Workspace; disabled: boolean }) {
  const [data, setData] = useState<ScriptEvaluationState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [datasetKey, setDatasetKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(20);
  const [generation, setGeneration] = useState(0);
  const readGeneration = useRef(0), alive = useRef(true), acting = useRef(false);
  const ledgerVersion = workspace.state?.operations.length;
  async function refresh() {
    const ticket = ++readGeneration.current;
    try {
      const next = await fetchJson<ScriptEvaluationState>('/api/preferences/script-evaluation');
      if (alive.current && ticket === readGeneration.current) {
        setData(next); setError('');
        setSelected(ids => ids.filter(id => next.cases.some(c => c.judgmentId === id && c.available)));
      }
    } catch (e) {
      if (alive.current && ticket === readGeneration.current) { setData(null); setError(e instanceof Error ? e.message : String(e)); }
    }
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; readGeneration.current += 1; }; }, []);
  useEffect(() => { setData(null); setGeneration(n => n + 1); void refresh(); }, [ledgerVersion]);
  const locked = disabled || busy || !data;
  const selectedDataset = data?.datasets.find(d => `${d.dataset.id}:${d.dataset.version}` === datasetKey);
  async function freeze() {
    if (locked || acting.current || !selected.length) return;
    acting.current = true; setBusy(true); setError('');
    try {
      const base = preferenceCommandBase();
      const prepared = await putJsonPost<{ dataset: ScriptEvaluationDataset }>('/api/preferences/script-dataset-prepare', {
        id: crypto.randomUUID(), version: 1, frozenAt: base.at, caseIds: selected,
      });
      if (!alive.current) return;
      await workspace.execute({ ...base, kind: 'script_dataset', dataset: prepared.dataset });
      if (alive.current) { setSelected([]); setDatasetKey(`${prepared.dataset.id}:${prepared.dataset.version}`); await refresh(); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { acting.current = false; if (alive.current) setBusy(false); }
  }
  async function withdraw(judgmentId: string) {
    if (locked || acting.current) return;
    acting.current = true; setBusy(true); setError('');
    try {
      const base = preferenceCommandBase();
      await workspace.execute({ ...base, kind: 'decision', event: { schemaVersion: 1, type: 'withdrawal',
        id: crypto.randomUUID(), operationId: base.operationId, createdAt: base.at, actor: base.actor,
        targetId: judgmentId, reason: '台本の比較画面で学習への同意を撤回' } });
      if (alive.current) await refresh();
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { acting.current = false; if (alive.current) setBusy(false); }
  }
  return <section className="script-evaluation" aria-label="台本の判断を比較する" aria-busy={busy}>
    <h3>台本の判断を、次の検証に使う</h3>
    <p>各案件で残した字幕表記・構成の採用例と却下例を、同じ入力で比較します。別の案の良し悪しは、人が判断するまで未判定です。</p>
    <p>利用に同意した記録を対象にします。採用した例は編集の保存確認も必要です。ルールを自動で有効にする機能ではありません。</p>
    {data?.syntheticWorkspace && <p className="preference-notice">合成例による動作検証です。人の好みの評価や品質の証明には使いません。</p>}
    {error && <p className="preference-error" role="alert">{error.replace(/^[A-Z_]+:\s*/, '')}</p>}
    <div className="preference-actions">
      <button type="button" disabled={disabled || busy} onClick={() => { setGeneration(n => n + 1); void refresh(); }}>台本の記録を読み直す</button>
      <button type="button" disabled={locked || !selected.length} onClick={() => void freeze()}>選んだ{selected.length}件の台本判断を固定</button>
    </div>
    {data && !data.cases.length && <p className="preference-empty">台本の判断はまだありません。台本タブで変更案を確認し、採用・却下と学習への利用を選ぶと、ここに記録が表示されます。</p>}
    {data?.cases.slice(0, visible).map(item => {
      const event = workspace.state?.decisions.events.find(e => e.id === item.judgmentId);
      return <article className="preference-record" key={item.judgmentId}>
        <label><input type="checkbox" disabled={locked || !item.available} checked={selected.includes(item.judgmentId)}
          onChange={e => setSelected(ids => e.target.checked ? [...ids, item.judgmentId] : ids.filter(id => id !== item.judgmentId))} />
          {item.kind === 'caption' ? '字幕表記' : '台本構成'}・{decisions[item.decision]}・案件 {item.projectId}</label>
        <p>{item.labelSource === 'synthetic' ? '合成例' : '人の判断として記録'} ／ {item.available ? '比較に利用できます' : item.reasons.map(reason => reasons[reason] ?? reason).join(' ／ ')}</p>
        {event?.type === 'script_judgment' && <><p>{event.note || '補足は未入力です'}</p>
          <ScriptOperationDetails artifact={event.artifact} modification={event.modification} />
          {event.learningConsent && !item.reasons.includes('WITHDRAWN') && <button type="button" disabled={locked}
            onClick={() => void withdraw(event.id)}>この台本判断の学習同意を撤回</button>}</>}
      </article>;
    })}
    {data && data.cases.length > visible && <button type="button" onClick={() => setVisible(n => n + 20)}>台本の判断をさらに表示</button>}
    <label className="script-evaluation-dataset">固定した台本の評価データ<select value={datasetKey} disabled={locked} onChange={e => setDatasetKey(e.target.value)}>
      <option value="">評価データを選ぶ</option>
      {data?.datasets.map(({ dataset, available }) => <option key={`${dataset.id}:${dataset.version}`} value={`${dataset.id}:${dataset.version}`}>
        {dataset.cases.length}件・第{dataset.version}版・{new Date(dataset.frozenAt).toLocaleString('ja-JP')}{!available ? '（現在は利用できません）' : ''}
      </option>)}
    </select></label>
    {selectedDataset && !selectedDataset.available && <p className="preference-error" role="status">{selectedDataset.reason?.replace(/^[A-Z_]+:\s*/, '')}</p>}
    {selectedDataset?.available && <ScriptModelComparisonPanel key={`${datasetKey}:${generation}`}
      dataset={selectedDataset.dataset} disabled={locked} />}
  </section>;
}

import {ExternalEditHistory} from './ExternalEditHistory';
import { useEffect, useRef, useState } from 'react';
import type { PublicEditorOperation } from '../../shared/editorOperations';
import type { EditorActivityPage } from '../../shared/editorActivity';
import type { EditorTextChange, EditorTextTarget } from '../../shared/editorCommands';
import { editorReviewTarget, type EditorReviewTarget } from '../../shared/editorReview';
import { fetchJson } from '../fetchJson';
import { editorAgentPost } from '../useEditorAgentConnection';
import { useDialogEscape } from '../useDialogEscape';
import { useFocusTrap } from '../useFocusTrap';
import '../preferences/preferences.css';
import { AgentOperationSummary } from './AgentOperationSummary';
import { ScriptOperationDetails, ScriptSavedStateReview } from './ScriptOperationDetails';
import type { SavedScriptEditReview } from '../../server/editorAgentContext';
import { TextChangeComparison } from './TextChangeComparison';
import {NativeOperationDetails,NativeSavedStateReview} from './NativeOperationDetails';
import type {NativeEditorReconciliation} from '../../shared/nativeEditorEvidence';

interface Props {
  projectId: string | null; credentials: { sessionId: string; sessionKey: string };
  connection: 'connecting' | 'connected' | 'offline'; connectionError: string | null; onClose(): void;
  externalHistory?: boolean;
  onReview?: (target: EditorReviewTarget) => void;
}
interface Review {
  runId: string; snapshotHash: string; targets: Array<EditorTextChange & { current: EditorTextTarget | null }>;
  reviewId: string;
  script?: SavedScriptEditReview;
  sequence?:NativeEditorReconciliation;
}
const PHASES: Record<PublicEditorOperation['phase'], string> = {
  queued: '受付済み', running: '編集画面への反映待ち', applied: '反映済み・保存を確認中',
  saved: '保存済み', failed: '処理を完了できませんでした', cancelled: '停止済み', unknown: '結果の確認が必要です',
};
const ACTIVITY_POLL_MS = 2000;
const ACTIVITY_TIMEOUT_MS = 10_000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^[A-Z_]+:\s*/, '');

/** primary側の表示順と内容を優先し、page境界の重複をrunIdで除く。 */
export function mergeActivityOperations(
  primary: PublicEditorOperation[],
  secondary: PublicEditorOperation[],
): PublicEditorOperation[] {
  const seen = new Set<string>();
  return [...primary, ...secondary].filter((operation) => {
    if (seen.has(operation.runId)) return false;
    seen.add(operation.runId); return true;
  });
}

function activityUrl(projectId: string | null, offset?: number): string {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  if (offset !== undefined) params.set('offset', String(offset));
  const query = params.toString();
  return `/api/editor/operations${query ? `?${query}` : ''}`;
}

export function AgentActivityDialog({ projectId, credentials, connection, connectionError, onClose, onReview, externalHistory=false }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [operations, setOperations] = useState<PublicEditorOperation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [historySnapshot, setHistorySnapshot] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [review, setReview] = useState<Review | null>(null); const [confirmed, setConfirmed] = useState(false);
  const requestGeneration = useRef(0);
  const latestLoaded = useRef(false); const latestTotal = useRef<number | null>(null);
  const browsingOlder = useRef(false);
  useDialogEscape(onClose, !working); useFocusTrap(root);
  useEffect(() => {
    const generation = ++requestGeneration.current;
    let pollTimer: number | undefined; let controller: AbortController | null = null;
    latestLoaded.current = false; latestTotal.current = null; browsingOlder.current = false;
    setOperations([]); setLoaded(false); setError(''); setNotice(''); setNextOffset(null);
    setLoadingOlder(false); setHistorySnapshot(false);
    const refresh = async () => {
      if (browsingOlder.current) return;
      controller = new AbortController();
      let timeout: number | undefined;
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => {
            controller?.abort(); reject(new Error('履歴の応答がありません。もう一度読み込んでください。'));
          }, ACTIVITY_TIMEOUT_MS);
        });
        const response = await Promise.race([
          fetchJson<EditorActivityPage>(activityUrl(projectId), { signal: controller.signal }),
          timedOut,
        ]);
        if (generation !== requestGeneration.current || browsingOlder.current) return;
        const totalChanged = latestTotal.current !== null && latestTotal.current !== response.total;
        setOperations((current) => !latestLoaded.current || totalChanged
          ? response.operations : mergeActivityOperations(response.operations, current));
        setNextOffset(response.nextOffset ?? null);
        if (totalChanged) setNotice('新しいAI作業が追加されたため、履歴を最新から並べ直しました。');
        latestLoaded.current = true; latestTotal.current = response.total;
        setLoaded(true); setError('');
      } catch (e) {
        if (generation !== requestGeneration.current || browsingOlder.current) return;
        setLoaded(true);
        setError(latestLoaded.current
          ? `履歴を更新できません。表示中の内容は前回取得時のものです。${message(e)}` : message(e));
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout);
        controller = null;
        if (generation === requestGeneration.current && !browsingOlder.current) {
          pollTimer = window.setTimeout(() => { void refresh(); }, ACTIVITY_POLL_MS);
        }
      }
    };
    void refresh();
    return () => {
      requestGeneration.current += 1; controller?.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    };
  }, [projectId, refreshKey]);
  async function loadOlder() {
    if (nextOffset === null || loadingOlder) return;
    const generation = requestGeneration.current; const offset = nextOffset;
    const controller = new AbortController(); let timeout: number | undefined;
    browsingOlder.current = true; setHistorySnapshot(true); setLoadingOlder(true); setError('');
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => {
          controller.abort(); reject(new Error('前の履歴の応答がありません。もう一度読み込んでください。'));
        }, ACTIVITY_TIMEOUT_MS);
      });
      const response = await Promise.race([
        fetchJson<EditorActivityPage>(activityUrl(projectId, offset), { signal: controller.signal }),
        timedOut,
      ]);
      if (generation !== requestGeneration.current) return;
      setOperations((current) => mergeActivityOperations(current, response.operations));
      setNextOffset(response.nextOffset ?? null);
    } catch (e) {
      if (generation === requestGeneration.current) setError(`前の履歴を読み込めません。${message(e)}`);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (generation === requestGeneration.current) setLoadingOlder(false);
    }
  }
  async function action(task: () => Promise<void>) {
    if (working) return;
    setWorking(true); setError(''); setNotice('');
    try { await task(); } catch (e) { setError(message(e)); }
    finally { setWorking(false); }
  }
  return <div className="preference-overlay" data-editor-activity={working ? 'working' : review ? 'reviewing' : 'viewing'}>
    <div ref={root} className="preference-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-activity-title" data-testid="agent-activity-dialog">
      <header className="preference-header"><div><h2 id="agent-activity-title">AIの作業</h2>
        <p>{connection === 'connected' ? 'この編集画面と接続しています' : connection === 'connecting' ? '接続を確認しています' : '接続を確認してください'}</p></div>
        <button type="button" disabled={working} onClick={onClose} aria-label="AIの作業を閉じる">閉じる</button></header>
      <div className="preference-body">
        {(error || connectionError) && <p role="alert">{error || message(connectionError)}</p>}
        {error && !historySnapshot && <button type="button" disabled={working} onClick={() => setRefreshKey((value) => value + 1)}>履歴をもう一度読み込む</button>}
        {notice && <p role="status">{notice}</p>}
        <p>AIが変更した内容はここで見比べられます。直前の変更は「元に戻す」で取り消せます。開き直した動画は、字幕を直接修正できます。</p>
        {!loaded ? <p>履歴を読み込んでいます…</p> : !error && operations.length === 0 ? <p>{externalHistory?'画面内のAI操作の記録はありません。':'この動画には、まだAIの編集記録がありません。'}</p> : null}
        {externalHistory && projectId && <ExternalEditHistory projectId={projectId}/>}
        {operations.map((operation) => <section className="preference-card" key={operation.runId}>
          <AgentOperationSummary operation={operation} snapshot={historySnapshot}
            executionLabel={PHASES[operation.phase] + (operation.reconciliation ? '・確認して再開済み' : '')} />
          {!projectId && <small>{operation.request.projectId}</small>}
          <p>{operation.confirmed.applied ? '画面への反映を確認済み' : '画面への反映は未確認'} ／ {operation.confirmed.saved ? '保存を確認済み' : '保存は未確認'}</p>
          {operation.cancelRequested && <p>停止を要求しています。停止前に反映・保存されていた内容は、上の結果に残ります。</p>}
          {operation.request.sequence?<NativeOperationDetails edit={operation.request.sequence}/>:operation.request.script ? <ScriptOperationDetails artifact={operation.request.script.artifact} modification={operation.request.script.modification} /> : <details><summary>変更前と変更案を見比べる（{operation.request.changes.length}件）</summary>
            {operation.request.changes.map((change, index) => <div className="preference-card" key={change.elementId}>
              <strong>変更 {index + 1}</strong>
              <TextChangeComparison before={change.before} after={change.after} />
              {operation.review?.judgments[index] && <p>記録した判断：{{ accepted: '採用', accepted_modified: '直して採用', rejected: '却下', deferred: '後で判断' }[operation.review.judgments[index]!.decision]}</p>}
              {typeof operation.review?.judgments[index]?.recordedText === 'string' && <div className="agent-judgment-text">
                <p className="agent-text-comparison">判断で残した本文：{operation.review.judgments[index]!.recordedText}</p>
                <small>判断時点の記録です。その後の編集は含みません。</small>
              </div>}
              {onReview && operation.request.projectId === projectId && operation.confirmed.applied
                && (['saved', 'failed', 'cancelled'].includes(operation.phase) || !!operation.reconciliation)
                && <button type="button" disabled={working} onClick={() => onReview(editorReviewTarget(operation, index))}>この変更を判断する</button>}
            </div>)}
          </details>}
          {['queued', 'running', 'applied'].includes(operation.phase) && <button type="button" disabled={working || operation.cancelRequested}
            onClick={() => void action(async () => { await editorAgentPost('cancel', { runId: operation.runId }); setNotice('停止を要求しました。実際の結果は履歴で確認できます。'); })}>停止を要求する</button>}
          {operation.phase === 'unknown' && !operation.reconciliation && <button type="button" disabled={working}
            onClick={() => void action(async () => {
              const response = await editorAgentPost<Omit<Review, 'reviewId'>>('review', { ...credentials, runId: operation.runId });
              if (operation.request.script && !response.script) throw new Error('台本の保存内容を取得できませんでした。もう一度確認してください。');
              if(operation.request.sequence&&!response.sequence)throw new Error('タイムラインの保存内容を取得できませんでした。もう一度確認してください。');
              setReview({ ...response, reviewId: crypto.randomUUID() }); setConfirmed(false);
            })}>保存内容を確認して再開</button>}
          {operation.confirmed.applied && <small>{operation.humanReview === 'reviewed' ? 'すべての変更への判断を記録済みです。'
            : operation.humanReview === 'partial' ? `${operation.review?.completed ?? 0}件の判断を記録済みです。`
              : operation.humanReview === 'unavailable' ? '判断の記録を読み取れません。編集の好みで記録を確認してください。' : '内容の確認待ちです。'}
            {operation.review?.synthetic ? '検証用の合成判断を含みます。' : ''}学習に使うかどうかは、判断時に別に選びます。</small>}
        </section>)}
        {historySnapshot && <p>表示中の前の履歴は取得時点の内容です。別画面で判断した内容や新しいAI作業を見るには、最新の履歴に更新してください。</p>}
        <div className="preference-actions">
          {nextOffset !== null && <button type="button" disabled={loadingOlder || working} onClick={() => void loadOlder()}>
            {loadingOlder ? '前の履歴を読み込んでいます…' : 'さらに前の履歴を表示'}
          </button>}
          {historySnapshot && <button type="button" disabled={loadingOlder || working} onClick={() => setRefreshKey((value) => value + 1)}>
            最新の履歴に更新
          </button>}
        </div>
        {review && <section className="preference-card" aria-label="再開する保存内容">
          <h3>この保存内容から再開します</h3>
          <p>過去の処理結果は「結果不明」のまま残ります。この操作は変更案を再実行しません。</p>
          {review.sequence?<NativeSavedStateReview inspection={review.sequence}/>:review.script ? <ScriptSavedStateReview inspection={review.script} /> : <>
            <p>取得時点の画面と保存済みの字幕が一致することを確認しました。</p>
            {review.targets.map((target, index) => <p key={target.elementId}>変更 {index + 1} の現在の字幕：{target.current?.text ?? '削除されています'}</p>)}
          </>}
          <label className="preference-consent"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />この内容を確認し、ここから作業を続けます</label>
          <button type="button" className="preference-primary" disabled={!confirmed || working} onClick={() => void action(async () => {
            await editorAgentPost('reconcile', { ...credentials, runId: review.runId, reviewId: review.reviewId,
              snapshotHash: review.snapshotHash, confirmedCurrentSavedState: true });
            setReview(null); setConfirmed(false); setNotice('保存内容の確認を記録しました。新しいAI編集を再開できます。');
          })}>この保存内容から再開する</button>
        </section>}
      </div>
      <footer className="preference-footer">AIの処理結果と、人が採用した判断は別の記録です。</footer>
    </div>
  </div>;
}

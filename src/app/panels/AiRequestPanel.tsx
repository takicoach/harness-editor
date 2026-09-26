import { useEffect, useRef, useState } from 'react';
import {TaskProgress} from '../components/TaskProgress';
import type { InstructionContext, InstructionInput, InstructionRecord } from '../../shared/types';
import { useEventChannel } from '../eventBus';
import { fetchJson, putJsonPost } from '../fetchJson';
import { useAgentConnected } from '../useAgentConnected';
import { AiTerminal } from './AiTerminal';
import './aiRequestPanel.css';

interface Draft { text: string; pending: InstructionInput | null }
const storageKey = (projectId: string) => `sme.ai-request.${projectId}`;
function readDraft(projectId: string): Draft {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey(projectId)) ?? 'null');
    if (data?.version === 1 && typeof data.text === 'string') {
      const input = data.pending;
      if (input == null) return { text: data.text, pending: null };
      if (input.projectId === projectId && typeof input.requestId === 'string'
        && typeof input.text === 'string' && Number.isSafeInteger(input.requestCreatedAt)
        && input.context && Number.isFinite(input.context.frame) && Number.isFinite(input.context.timeSec)) {
        return { text: data.text, pending: input };
      }
    }
  } catch { /* Storage may be disabled; sending will require a successful durable write. */ }
  return { text: '', pending: null };
}
function writeDraft(projectId: string, draft: Draft) {
  localStorage.setItem(storageKey(projectId), JSON.stringify({ version: 1, ...draft }));
}
const statusText: Record<InstructionRecord['status'], string> = {
  pending: '受付済み・AI待ち', processing: '処理中', done: '処理結果あり', failed: '失敗',
};
const rank = { pending: 0, processing: 1, done: 2, failed: 2 };

/** Mounted with a project key: responses, input context and drafts cannot cross projects. */
export function AiRequestPanel({ projectId, buildContext, onOpenActivity }: {
  projectId: string; buildContext: () => InstructionContext; onOpenActivity?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => readDraft(projectId));
  const draftRef = useRef(draft);
  const [records, setRecords] = useState<InstructionRecord[]>([]);
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refresh, setRefresh] = useState(0);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const accepted = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const active = useRef(true);
  const connected = useAgentConnected(true, projectId);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  function remember(next: Draft) {
    writeDraft(projectId, next);
    draftRef.current = next;
    if (active.current) setDraft(next);
  }
  function accept(record: InstructionRecord) {
    if (!active.current || record.projectId !== projectId) return;
    if (record.requestId) accepted.current.add(record.requestId);
    setRecords(previous => {
      const existing = previous.find(item => item.id === record.id);
      if (existing && (existing.updatedAt > record.updatedAt
        || (existing.updatedAt === record.updatedAt && rank[existing.status] > rank[record.status]))) return previous;
      return [...previous.filter(item => item.id !== record.id), record]
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    });
    if (record.requestId && draftRef.current.pending?.requestId === record.requestId) {
      try { remember({ text: '', pending: null }); setError(null); }
      catch { setError('受付済みですが、このブラウザの下書きを更新できません。履歴で受付番号を確認できます。'); }
    }
  }
  function receive(message: unknown) {
    const event = message as { type?: string; record?: InstructionRecord };
    if (event.type === 'update' && event.record && event.record.status in statusText) accept(event.record);
  }
  useEventChannel('claude', receive, projectId);
  const receiveRef = useRef(receive);
  receiveRef.current = receive;
  useEffect(() => {
    let cancelled = false;
    setHistoryState('loading');
    fetchJson<{ messages: unknown[] }>(`/api/events/sync?id=${encodeURIComponent(projectId)}&ch=claude`)
      .then(body => {
        if (!Array.isArray(body.messages)) throw new Error('履歴の形式が不正です');
        if (cancelled) return;
        for (const message of body.messages) receiveRef.current(message);
        setHistoryState('ready');
      }).catch(() => { if (!cancelled) setHistoryState('error'); });
    return () => { cancelled = true; };
  }, [projectId, refresh]);

  async function send() {
    if (sendingRef.current || (!draftRef.current.pending && !draftRef.current.text.trim())) return;
    sendingRef.current = true; setSending(true); setError(null);
    let request: InstructionInput | null = null;
    try {
      request = draftRef.current.pending ?? {
        projectId, text: draftRef.current.text.trim(), context: buildContext(),
        requestId: crypto.randomUUID(), requestCreatedAt: Date.now(),
      };
      // Persist before the network can accept the request. Retry uses this exact context and ID.
      remember({ text: draftRef.current.text, pending: request });
      const record = await putJsonPost<InstructionRecord>('/api/instructions', request);
      if (record.projectId !== projectId || record.requestId !== request.requestId) throw new Error('受付結果が依頼と一致しません');
      if (active.current) accept(record);
      // Switching projects must not clear a newer draft in the same project's next mounted panel.
      else if (readDraft(projectId).pending?.requestId === request.requestId) writeDraft(projectId, { text: '', pending: null });
    } catch (cause) {
      if (active.current && (!request?.requestId || !accepted.current.has(request.requestId))) {
        setError(`受付を確認できませんでした。${cause instanceof Error ? cause.message : '接続を確認してください。'} 同じ依頼の受付確認ができます。`);
      }
    } finally {
      sendingRef.current = false;
      if (active.current) setSending(false);
    }
  }

  const available = connected.global === true || connected.dedicated === true;
  return <section className="ai-request-panel" aria-label="この案件のAI依頼">
    <header className="ai-request-heading"><h3>AIに依頼</h3>
      <span role="status">{available ? 'AI接続済み' : connected.global === null ? <TaskProgress compact label="接続を確認中"/> : 'AIの接続待ち'}</span></header>
    <p className="ai-request-help">この案件で直したいことを書いてください。今の再生位置と選択も添えて送ります。</p>
    <label htmlFor="ai-request-text">依頼内容</label>
    <textarea id="ai-request-text" rows={4} value={draft.text} disabled={sending || draft.pending !== null}
      placeholder="例：選んだ字幕の「アイアソ」を「アイアン」に直してください。"
      onChange={event => {
        const next = { text: event.target.value, pending: null };
        draftRef.current = next; setDraft(next);
        try { writeDraft(projectId, next); } catch { setError('下書きを保存できません。ブラウザの保存領域を確認してください。'); }
      }} />
    <div className="ai-request-actions"><button type="button" className="ai-request-send"
      disabled={sending || (!draft.pending && !draft.text.trim())} onClick={() => void send()}>
      {sending ? '受付を確認中…' : draft.pending ? 'この依頼の受付を確認' : '依頼を送る'}</button>
      <button type="button" aria-expanded={terminalOpen} onClick={() => setTerminalOpen(value => !value)}>
        {terminalOpen ? '接続画面を閉じる' : 'AIの接続・設定'}</button></div>
    {sending&&<TaskProgress compact label="依頼の受付を確認しています"/>}
    {error && <p className="ai-request-error" role="alert">{error}</p>}
    {!available && <p className="ai-request-help">依頼は保存されます。「AIの接続・設定」で接続し、待機を開始すると受け付けた依頼を処理します。</p>}
    {terminalOpen && <div className="ai-request-terminal"><AiTerminal /></div>}
    <div className="ai-request-history"><div className="ai-request-heading"><h3>この案件の依頼履歴</h3>
      <button type="button" onClick={() => setRefresh(value => value + 1)}>履歴を更新</button></div>
      {onOpenActivity ? <div className="ai-request-activity">
        <button type="button" aria-haspopup="dialog" onClick={onOpenActivity}>変更差分・保存状態を見る</button>
        <p className="ai-request-help">この案件でAIが編集した内容と、採用・却下の記録を確認できます。</p>
      </div> : <p className="ai-request-help">編集の保存状態と採用・却下は、画面上部の「AIの作業」で確認できます。</p>}
      {historyState === 'error' && <p role="alert" className="ai-request-error">履歴を確認できません。接続を確認して「履歴を更新」を押してください。</p>}
      {historyState==='loading'&&<TaskProgress compact label="履歴を確認中…"/>}
      {records.length === 0 && historyState!=='loading'&&<p className="ai-request-empty">{historyState === 'ready' ? 'まだ依頼はありません。' : '受付済みの依頼があるか不明です。'}</p>}
      {records.map(record => <article key={record.id} className="ai-request-record" data-state={record.status}>
        <div className="ai-request-record-head"><strong>{statusText[record.status]}</strong>
          <time dateTime={new Date(record.createdAt).toISOString()}>{new Date(record.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time></div>
        <p>{record.text}</p>
        {record.reply && <div className="ai-request-reply"><span>AIからの返答</span><p>{record.reply}</p></div>}
        <small>受付番号：{record.id}</small>
      </article>)}
    </div>
  </section>;
}

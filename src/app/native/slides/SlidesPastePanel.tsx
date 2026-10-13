import { useEffect, useRef, useState } from 'react';
import type { SlidesValidation } from '../../../server/slides/agent';
import type { SlidesOperationResult } from '../../../server/slides/operations';
import { Icon } from '../../Icon';
import { slidesRequest } from './slidesApi';
import { extractJson, normalizePages } from './pasteJson';
import type { SlidesRequestIntent } from './requestIntent';
import type { SlidesSessionHook } from './useSlidesSession';

/** 貼り付けの経路。①依頼文をコピー ②回答を貼る・読み込む ③同じ検証で確かめて、合格した分だけ採用。 */
export function SlidesPastePanel({ projectId, session, intent, onClose, onToast }: { projectId: string; session: SlidesSessionHook; intent: SlidesRequestIntent; onClose(): void; onToast(message: string): void }) {
  const outline = intent.kind === 'outline', regenerate = intent.kind === 'regenerate' || intent.kind === 'shorten';
  const [requestText, setRequestText] = useState(''), [keys, setKeys] = useState(intent.keys), [answer, setAnswer] = useState('');
  const [check, setCheck] = useState<SlidesValidation | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const textArea = useRef<HTMLTextAreaElement>(null), file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const params: Record<string, string> = outline ? { kind: 'outline' } : { kind: 'pages', keys: intent.keys.join(','), ...(regenerate ? { regenerate: '1' } : {}), ...(intent.kind === 'shorten' ? { shorten: '1' } : {}) };
    void slidesRequest<{ text: string; keys: string[] }>(projectId, '/request-text', undefined, params).then(result => { setRequestText(result.text); setKeys(result.keys); })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [projectId, intent, outline, regenerate]);
  const target = () => {
    const state = session.readCurrent();
    if (!state) throw new Error('スライドの編集データがありません');
    return { documentId: state.document.id, sessionId: state.sessionId, expectedRevision: state.document.revision, runId: state.document.generation?.runId };
  };
  const payload = () => {
    const parsed = extractJson(answer);
    if (!parsed.ok) throw new Error(parsed.message);
    return outline ? parsed.value : normalizePages(parsed.value);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(requestText); onToast('依頼文をコピーしました。使っている AI の画面に貼って送ってください'); }
    catch { textArea.current?.select(); onToast('自動でコピーできませんでした。依頼文の欄を選んでコピーしてください'); }
  };
  const verify = async () => {
    setBusy(true); setError(null); setCheck(null);
    try { setCheck(await slidesRequest<SlidesValidation>(projectId, '/validate', { ...target(), kind: outline ? 'outline' : 'pages', regenerate, payload: payload() })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const adopt = async () => {
    setBusy(true); setError(null);
    try {
      const result = await slidesRequest<SlidesOperationResult>(projectId, '/apply', { ...target(), kind: outline ? 'outline' : 'pages', regenerate, operationId: crypto.randomUUID(), payload: payload() });
      const applied = result.pages.filter(item => item.result === 'applied' || item.result === 'proposal').length;
      if (result.status === 'rejected') { setError('採用できるものがありませんでした。問題の箇所を直して、もう一度確かめてください'); return; }
      onToast(outline ? '構成案を受け取りました。左の「構成案」で確かめてください' : `${applied} ページを採用しました${result.pages.some(item => item.result === 'proposal') ? '（手で直したページは置き換え案になりました）' : ''}`);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const canAdopt = !!check && !busy && (outline ? check.ok : check.pages.some(item => item.ok));
  return <div className="native-slides-dialog" role="dialog" aria-label="貼り付けで頼む">
    <header className="native-slides-dialog-head"><strong>{outline ? '構成案を貼り付けで頼む' : `本文を貼り付けで頼む（${keys.join('・')}）`}</strong>
      <button type="button" className="btn-ghost native-header-icon" aria-label="閉じる" title="閉じる" onClick={onClose}><Icon name="x" /></button></header>
    <ol className="native-slides-steps">
      <li><strong>依頼文をコピー</strong>
        <p className="native-thumbnail-note">ChatGPT・Claude など、どの AI に貼ってもかまいません。返ってきた答え（JSON）を下に貼ります。画像はここでは受け取らないので、あとで「取り込み」から入れてください。</p>
        <div className="native-slides-row"><button type="button" className="btn-primary" disabled={!requestText} onClick={() => void copy()}>依頼文をコピー</button></div>
        <textarea ref={textArea} className="native-slides-request" aria-label="依頼文" readOnly value={requestText} /></li>
      <li><strong>AI の回答（JSON）を貼り付けるか、ファイルで読み込む</strong>
        <textarea className="native-slides-answer" aria-label="AI の回答" value={answer} onChange={event => { setAnswer(event.target.value); setCheck(null); }} placeholder="ここに貼り付け" />
        <div className="native-slides-row">
          <button type="button" className="btn-ghost" onClick={() => file.current?.click()}>ファイルを読み込む</button>
          <input ref={file} type="file" hidden aria-label="回答のファイル" accept=".json,.txt,application/json,text/plain"
            onChange={event => { const picked = event.target.files?.[0]; if (picked) void picked.text().then(value => { setAnswer(value); setCheck(null); }); event.target.value = ''; }} />
          <button type="button" className="btn-secondary" disabled={!answer.trim() || busy} onClick={() => void verify()}>確かめる</button>
        </div></li>
      <li><strong>結果を見て採用</strong>
        {check && <ul className="native-slides-check" aria-label="確かめた結果">
          {check.issues.map((issue, index) => <li key={`request-${index}`} data-ok="false">{issue.path ? `${issue.path}: ` : ''}{issue.message}</li>)}
          {outline && check.ok && <li data-ok="true">構成案は合格です</li>}
          {check.pages.map(item => <li key={item.index} data-ok={item.ok ? 'true' : 'false'}>{item.key ?? `${item.index + 1} 件目`}: {item.ok ? '合格'
            : item.issues.map(issue => `${issue.path} ${issue.message}`).join(' ／ ')}</li>)}
        </ul>}
        <div className="native-slides-row"><button type="button" className="btn-primary" disabled={!canAdopt} onClick={() => void adopt()}>{outline ? 'この構成案を使う' : '合格したページを採用'}</button></div></li>
    </ol>
    {error && <p className="native-slides-dialog-error" role="alert">{error}</p>}
  </div>;
}

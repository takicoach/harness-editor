import { useEffect, useId, useRef, useState } from 'react';
import { FEEDBACK_TITLE, buildDraft, githubIssueUrl, mailtoUrl, prepareFeedbackText, type FeedbackEnvironment, type FeedbackScreen } from '../../shared/feedbackDraft';
import { FEEDBACK_EMAIL, FEEDBACK_GITHUB_REPO } from '../../shared/feedbackTarget';

type Props = {
  draft: string;
  onClose(): void;
  email?: string;
  githubRepo?: string;
  openExternal?(url: string): void;
  copy?(body: string): Promise<void>;
};

const openInBrowser = (url: string) => { window.open(url,'_blank','noopener,noreferrer'); };
const copyText = (body: string) => navigator.clipboard.writeText(body);

export function FeedbackCard({draft, onClose, email=FEEDBACK_EMAIL, githubRepo=FEEDBACK_GITHUB_REPO,
  openExternal=openInBrowser, copy=copyText}: Props) {
  const id = useId(), firstField = useRef<HTMLInputElement>(null);
  const [comment,setComment] = useState('');
  const [edited,setEdited] = useState(draft);
  const [notice,setNotice] = useState('');
  useEffect(() => { firstField.current?.focus(); }, []);
  const outgoing = prepareFeedbackText(edited);
  const mail = mailtoUrl(email,FEEDBACK_TITLE,outgoing.body);
  const github = githubIssueUrl(githubRepo,FEEDBACK_TITLE,outgoing.body);
  const shortened = (github && outgoing.truncated) || (mail && new URL(mail).searchParams.get('body') !== outgoing.body);

  const changeComment = (value: string) => {
    setEdited(current => {
      const previous = comment ? comment+'\n\n' : '';
      const details = current.startsWith(previous) ? current.slice(previous.length) : current;
      return value ? value+'\n\n'+details : details;
    });
    setComment(value);
  };
  const copyDraft = async () => {
    try { await copy(outgoing.body); setNotice('コピーしました'); }
    catch { setNotice('コピーできませんでした。「送られる内容」からコピーしてください。'); }
  };

  return <aside className="feedback-card" role="region" aria-labelledby={id}>
    <header>
      <h2 id={id}>ご意見・不具合を送る</h2>
      <button type="button" className="btn btn-ghost" aria-label="ご意見ボックスを閉じる" onClick={onClose}>×</button>
    </header>
    <label>何が起きましたか（任意）<input ref={firstField} value={comment} onChange={event=>changeComment(event.target.value)}/></label>
    <label>送られる内容<textarea rows={7} value={edited} onChange={event=>setEdited(event.target.value)}/></label>
    {shortened && <p>外部で開く下書きは末尾を省きます。全文はコピーできます。</p>}
    <footer>
      {mail && <button type="button" className="btn btn-secondary" onClick={()=>openExternal(mail)}>メールで送る</button>}
      {github && <button type="button" className="btn btn-secondary" onClick={()=>openExternal(github)}>GitHub で報告する</button>}
      <button type="button" className="btn btn-primary" onClick={()=>void copyDraft()}>内容をコピー</button>
    </footer>
    {github && <p>GitHub のアカウントが必要です。</p>}
    {notice && <p role="status">{notice}</p>}
  </aside>;
}


export function useFeedbackBox(environment: FeedbackEnvironment | undefined) {
  const [draft,setDraft] = useState<{body:string; key:number} | null>(null);
  const launch = (screen: FeedbackScreen, errorText?: string, projectName?: string) => {
    const body = buildDraft({...environment,screen,errorText,projectName}).body;
    setDraft(previous => ({body,key:(previous?.key ?? 0)+1}));
  };
  return {launch, card:draft && <FeedbackCard key={draft.key} draft={draft.body} onClose={()=>setDraft(null)}/>};
}

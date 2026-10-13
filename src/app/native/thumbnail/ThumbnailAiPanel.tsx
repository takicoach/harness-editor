import { useState } from 'react';
import { THUMBNAIL_MAX_PAGES } from '../../../core/thumbnail/model';
import { THUMBNAIL_AI_CUTOUT_LABEL, THUMBNAIL_AI_CUTOUTS, type ThumbnailAiCutout, type ThumbnailAiKind } from '../../../shared/thumbnailAi';
import { Icon } from '../../Icon';
import { focusAiTerminal } from '../../panels/aiTerminalFocus';
import type { ThumbnailEditor } from './useThumbnailEditor';
import type { ThumbnailAi } from './useThumbnailAi';

/** 右の列（つまみの上）の「AI に頼む」。依頼文を AI タブの入力欄に貼るだけで、送るのは利用者の Enter。状態の照会（ai）と欄の開閉は親が持ち、つまみを畳んでも続く。 */
export function ThumbnailAiPanel({ editor, ai, open, onOpenChange, onOpenAi }: { editor: ThumbnailEditor; ai: ThumbnailAi; open: boolean; onOpenChange(open: boolean): void; onOpenAi(): void }) {
  const pages = editor.document.pages, setOpen = onOpenChange;
  const [kind, setKind] = useState<ThumbnailAiKind>('new'), [cutout, setCutout] = useState<ThumbnailAiCutout>('auto');
  const [note, setNote] = useState(''), [replace, setReplace] = useState('');
  const full = pages.length >= THUMBNAIL_MAX_PAGES, needsReplace = kind === 'new' && full, ready = !needsReplace || pages.some(page => page.id === replace);
  const submit = async () => {
    if (!ai.connected) { onOpenAi(); return; }
    const sent = await ai.send({ kind, pageId: kind === 'edit' ? editor.pageId : needsReplace ? replace : null, cutout, note });
    if (sent) { onOpenAi(); focusAiTerminal(); setNote(''); setOpen(false); }
  };
  return (
    <section className="native-thumbnail-ai-ask" aria-label="AI に頼む">
      <button type="button" className="btn-ghost native-thumbnail-ai-ask-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>AI に頼む</button>
      {open && <div className="native-thumbnail-ai-ask-form">
        <fieldset><legend>頼むこと</legend>
          <label><input type="radio" name="thumbnail-ai-kind" checked={kind === 'new'} onChange={() => setKind('new')} />新しい案を作る</label>
          <label><input type="radio" name="thumbnail-ai-kind" checked={kind === 'edit'} onChange={() => setKind('edit')} />選んでいる案を直す（{editor.page.name}）</label>
        </fieldset>
        {needsReplace && <label className="native-thumbnail-row">入れ替える案
          <select aria-label="入れ替える案" value={replace} onChange={event => setReplace(event.target.value)}>
            <option value="">選んでください</option>
            {pages.map(page => <option key={page.id} value={page.id}>{page.name}</option>)}
          </select></label>}
        <fieldset><legend>人物の切り抜き</legend>
          {THUMBNAIL_AI_CUTOUTS.map(value => <label key={value}><input type="radio" name="thumbnail-ai-cutout" checked={cutout === value} onChange={() => setCutout(value)} />{THUMBNAIL_AI_CUTOUT_LABEL[value]}</label>)}
        </fieldset>
        <label className="native-thumbnail-row">ひとこと<input aria-label="ひとこと" maxLength={100} value={note} onChange={event => setNote(event.target.value.replace(/\n/g, ' '))} /></label>
        <button type="button" className="btn-primary" disabled={!ready || ai.busy || editor.disabled} onClick={() => void submit()}>
          {ai.connected ? 'AI タブに入れる' : 'AI タブを開く'}</button>
        {!ai.connected && <p className="native-thumbnail-note">AI の準備ができたら、もう一度押してください</p>}
      </div>}
      {ai.error && <p className="native-thumbnail-note" data-state="failed">{ai.error}</p>}
      {ai.latest?.status && <p className="native-thumbnail-ai-state" role="status" data-state={ai.latest.status}>
        {ai.latest.label}{ai.latest.status === 'working' ? '（AI タブで質問していることがあります）' : ''}{ai.latest.message ? `: ${ai.latest.message}` : ''}</p>}
    </section>
  );
}

/** つまみを畳んだ細い列の「AI に頼む」。押すとつまみを開いて欄を出す。依頼が動いている・失敗した時は点で知らせ、状態は title に出す。 */
export function ThumbnailAiShortcut({ ai, onAsk }: { ai: ThumbnailAi; onAsk(): void }) {
  const status = ai.latest?.status, label = status && ai.latest?.label ? `AI に頼む（${ai.latest.label}）` : 'AI に頼む';
  return <button type="button" className="btn-ghost native-header-icon native-thumbnail-ai-shortcut" aria-label={label} title={label}
    data-state={status && status !== 'done' ? status : undefined} onClick={onAsk}><Icon name="sparkles" /></button>;
}

import { extractFields } from '../../../core/slides/build';
import { pageFit } from '../../../core/slides/fit';
import { layoutSlots } from '../../../core/slides/layouts';
import type { SlideDocument, SlidePage } from '../../../core/slides/model';
import { paragraphRangeLabel, STATUS_LABELS } from './outlineView';
import { pageGenerationInfo, proposalSummary } from './pageInfo';
import type { SlidesRequestIntent } from './requestIntent';
import type { SlidesSessionHook } from './useSlidesSession';

/** 右のつまみの下: 収まり・元の台本・置き換え案・作り直し。 */
export function SlidesPageInfo({ document, page, session, aiBusy = false, onRequest, onLayout, onToast }: {
  document: SlideDocument; page: SlidePage; session: SlidesSessionHook; /** AI が受付済み・作業中（依頼のボタンを押せなくする）。 */ aiBusy?: boolean; onRequest(intent: SlidesRequestIntent): void; onLayout(): void; onToast(message: string): void;
}) {
  const fit = pageFit(page), info = pageGenerationInfo(document, page), busy = session.busy;
  const names = new Map(layoutSlots(page.layout, extractFields(page)).map(slot => [slot.id, slot.name]));
  const paragraphs = document.script.paragraphs.filter(paragraph => page.sourceParagraphIds.includes(paragraph.id));
  const shorten = () => info.key ? onRequest({ kind: 'shorten', keys: [info.key] })
    : onToast('AI に短くしてもらえるのは「台本から作る」で作ったページだけです。文字を直接短くするか、「分ける」「別のレイアウト」を使ってください');
  return <>
    <section className="native-thumbnail-knob-group" aria-label="収まり"><h3>収まり</h3>
      {fit.status === 'ok' ? <p className="native-slides-fit" data-status="ok">OK（すべての文字が枠に収まっています）</p> : <>
        <p className="native-slides-fit" data-status={fit.status}>{fit.status === 'overflow' ? '文字が多すぎて枠に収まりません' : '文字が小さすぎます（読みにくくなります）'}</p>
        <ul className="native-slides-fit-list">{fit.slots.filter(slot => slot.status !== 'ok').map(slot => <li key={slot.layerId}>{names.get(slot.slot) ?? slot.slot}: {slot.status === 'overflow'
          ? `高さ ${slot.height}px（枠は ${slot.limit}px）` : `${Math.round(slot.fontSize)}px（最小 ${slot.minFontSize}px）`}</li>)}</ul>
        <div className="native-slides-row">
          {fit.suggestions.includes('split') && <button type="button" className="btn-secondary" disabled={busy}
            onClick={() => void session.execute({ type: 'split-page', pageId: page.id, newPageId: `p-${crypto.randomUUID()}` })}>分ける</button>}
          <button type="button" className="btn-secondary" disabled={busy || aiBusy} onClick={shorten}>短くする</button>
          <button type="button" className="btn-secondary" onClick={onLayout}>別のレイアウト</button>
        </div>
        <p className="native-thumbnail-note">小さくして警告を消すことはしません。分ける・短くする・レイアウトを変えるのどれかで収めてください。</p>
      </>}
    </section>
    <section className="native-thumbnail-knob-group" aria-label="元の台本"><h3>元の台本: {paragraphRangeLabel(page.sourceParagraphIds) || 'なし'}</h3>
      {paragraphs.length > 0 && <details className="native-slides-source"><summary>本文を見る</summary>
        {paragraphs.map(paragraph => <p key={paragraph.id}><b>{paragraph.id}</b> {paragraph.text}</p>)}</details>}
    </section>
    {info.proposal && <section className="native-thumbnail-knob-group native-slides-proposal" aria-label="置き換え案"><h3>置き換え案</h3>
      <p className="native-thumbnail-note">このページは手で直してあるので、作り直した内容は案として届きました。採用すると置き換わります（元に戻すで戻せます）。</p>
      <ul className="native-slides-proposal-list">{proposalSummary(info.proposal).map((line, index) => <li key={index}>{line}</li>)}</ul>
      <div className="native-slides-row">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void session.execute({ type: 'adopt-proposal', pageId: page.id })}>採用する</button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void session.execute({ type: 'discard-proposal', pageId: page.id })}>捨てる</button>
      </div>
    </section>}
    {info.key && <section className="native-thumbnail-knob-group" aria-label="このページの生成"><h3>このページの生成: {info.status ? STATUS_LABELS[info.status] : '—'}</h3>
      {info.reasons.length > 0 && <ul className="native-slides-reasons">{info.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
      {info.canRegenerate && <button type="button" className="btn-secondary" disabled={busy || aiBusy}
        onClick={() => onRequest({ kind: info.status === 'generated' ? 'regenerate' : 'pages', keys: [info.key!] })}>このページを作り直す</button>}
      {page.editedAfterGeneration && <p className="native-thumbnail-note">手で直したページなので、作り直した内容は置き換え案として届きます。</p>}
    </section>}
  </>;
}

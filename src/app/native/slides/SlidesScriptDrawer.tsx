import { useState } from 'react';
import type { SlideCommand } from '../../../core/slides/commands';
import { SLIDE_LAYOUTS } from '../../../core/slides/layouts';
import { SLIDE_LAYOUT_IDS, type SlideLayoutId } from '../../../core/slides/model';
import { nextPendingKeys } from '../../../core/slides/prompts';
import { Icon } from '../../Icon';
import type { SlidesDrawerContext } from './SlidesDrawer';
import { generationCounts, outlineCoverage, outlineRows, STATUS_LABELS } from './outlineView';
import type { SlidesRequestIntent } from './requestIntent';

/** 「AI に頼む」「貼り付けで頼む」。使える経路のボタンだけを出す。 */
function RequestButtons({ context, intent, label, disabled = false }: { context: SlidesDrawerContext; intent: SlidesRequestIntent; label: string; disabled?: boolean }) {
  if (!context.ai && !context.paste) return null;
  const off = disabled || context.session.busy;
  const aiOff = off || !!context.ai?.busy;
  return <div className="native-slides-row">
    {context.ai && <button type="button" className="btn-primary" disabled={aiOff} onClick={() => void context.ai!.send(intent)}>{label}を AI に頼む</button>}
    {context.paste && <button type="button" className="btn-secondary" disabled={off} onClick={() => context.paste!(intent)}>{label}を貼り付けで頼む</button>}
  </div>;
}
/** 左の「台本から作る」: ①台本 ②構成案の確認と確定 ③本文の進み具合。 */
export function SlidesScriptDrawer({ context }: { context: SlidesDrawerContext }) {
  const { session, document } = context, generation = document.generation, paragraphs = document.script.paragraphs;
  const [editing, setEditing] = useState(!paragraphs.length), [text, setText] = useState('');
  const run = (command: SlideCommand) => void session.execute(command), busy = session.busy;
  const locked = generation?.status === 'outline' || generation?.status === 'generating';
  const rows = outlineRows(document), counts = generationCounts(document), coverage = outlineCoverage(document), pending = nextPendingKeys(document);
  const setScript = async () => { if (await session.execute({ type: 'set-script', text })) setEditing(false); };
  const canRequestOutline = paragraphs.length > 0 && !locked;
  return <div className="native-slides-script">
    <div className="native-slides-step"><h3>1. 台本</h3>
      {editing ? <>
        <textarea className="native-slides-script-input" aria-label="台本" value={text} onChange={event => setText(event.target.value)} placeholder="講義の台本を貼り付けます" />
        <p className="native-thumbnail-note">空行で段落に分け、p1・p2 … の番号を付けます（空行が無いときは 1 行ずつ）。</p>
        {generation && <p className="native-thumbnail-note">台本を入れ替えると、前の構成案の記録と元段落の対応は外れます（ページはそのまま残ります）。</p>}
        <div className="native-slides-row">
          <button type="button" className="btn-primary" disabled={!text.trim() || busy} onClick={() => void setScript()}>段落に分ける</button>
          {paragraphs.length > 0 && <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>やめる</button>}
        </div>
      </> : <>
        <p className="native-slides-script-count">{paragraphs.length} 段落</p>
        <details className="native-slides-paragraphs"><summary>段落を見る</summary>
          <ol>{paragraphs.map(paragraph => <li key={paragraph.id}><b>{paragraph.id}</b> {paragraph.text}</li>)}</ol></details>
        <button type="button" className="btn-ghost" disabled={locked || busy} title={locked ? '生成の途中は入れ替えられません。中止してから入れ替えてください' : undefined}
          onClick={() => { setText(paragraphs.map(paragraph => paragraph.text).join('\n\n')); setEditing(true); }}>台本を入れ替える</button>
      </>}
    </div>
    {paragraphs.length > 0 && <div className="native-slides-step"><h3>2. 構成案</h3>
      {canRequestOutline && <>
        <p className="native-thumbnail-note">{generation ? '構成案を作り直せます（今のページは残ります）。' : 'AI に、ページ割り・レイアウト・元の段落・用語の統一表を出してもらいます。'}</p>
        <RequestButtons context={context} intent={{ kind: 'outline', keys: [] }} label="構成案" />
      </>}
      {generation?.status === 'outline' && <>
        <p className="native-slides-coverage" data-complete={coverage.covered === coverage.total ? 'true' : 'false'}>全段落 {coverage.covered} / {coverage.total} がどれかのページに入っています</p>
        <ol className="native-slides-outline" aria-label="構成案">
          {rows.map(row => <li key={row.key} className="native-slides-outline-row">
            <span className="native-slides-outline-number">{row.index + 1}</span>
            <span className="native-slides-outline-title" title={row.title}>{row.title}</span>
            <select className="native-thumbnail-select" aria-label={`${row.index + 1} ページ目のレイアウト`} disabled={busy} value={row.layout}
              onChange={event => run({ type: 'set-outline-layout', key: row.key, layout: event.target.value as SlideLayoutId })}>
              {SLIDE_LAYOUT_IDS.map(id => <option key={id} value={id}>{SLIDE_LAYOUTS[id].name}</option>)}
            </select>
            <span className="native-slides-outline-range">{row.range}</span>
            <button type="button" className="btn-ghost native-header-icon" aria-label={`${row.index + 1} ページ目を上へ`} title="上へ" disabled={busy || row.index === 0}
              onClick={() => run({ type: 'move-outline-page', key: row.key, index: row.index - 1 })}><Icon name="arrow-up" /></button>
            <button type="button" className="btn-ghost native-header-icon" aria-label={`${row.index + 1} ページ目を下へ`} title="下へ" disabled={busy || row.index === rows.length - 1}
              onClick={() => run({ type: 'move-outline-page', key: row.key, index: row.index + 1 })}><Icon name="arrow-down" /></button>
            <button type="button" className="btn-ghost native-header-icon" aria-label={`${row.index + 1} ページ目を消す`} title="消す（段落は前のページへ移ります）" disabled={busy || rows.length <= 1}
              onClick={() => run({ type: 'remove-outline-page', key: row.key })}><Icon name="trash" /></button>
          </li>)}
        </ol>
        <p className="native-thumbnail-note">消したページの段落は、前のページ（先頭なら次のページ）に入ります。</p>
        <div className="native-slides-row">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => run({ type: 'confirm-outline' })}>この構成で作る</button>
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => run({ type: 'cancel-generation', runId: generation.runId })}>やめる</button>
        </div>
      </>}
      {generation?.status === 'cancelled' && !generation.confirmed && <div className="native-slides-row">
        <p className="native-thumbnail-note">構成案の確認を中止しています。</p>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => run({ type: 'resume-generation', runId: generation.runId })}>構成案の確認に戻る</button>
      </div>}
    </div>}
    {generation?.confirmed && <div className="native-slides-step"><h3>3. 本文</h3>
      <p className="native-slides-progress-count">{counts.generated} / {counts.total} ページができました{counts.failed ? `（失敗 ${counts.failed}）` : ''}{generation.status === 'cancelled' ? '（中止中）' : ''}</p>
      {generation.status === 'generating' && pending.length > 0 && <RequestButtons context={context} intent={{ kind: 'pages', keys: pending }} label={`次の ${pending.length} ページの本文`} />}
      <div className="native-slides-row">
        {generation.status === 'generating' && <button type="button" className="btn-ghost" disabled={busy} onClick={() => run({ type: 'cancel-generation', runId: generation.runId })}>中止</button>}
        {generation.status === 'cancelled' && <button type="button" className="btn-secondary" disabled={busy} onClick={() => run({ type: 'resume-generation', runId: generation.runId })}>続きから作る</button>}
      </div>
      <ol className="native-slides-progress" aria-label="本文の進み具合">
        {rows.map(row => <li key={row.key} className="native-slides-progress-row" data-status={row.status}>
          <button type="button" className="btn-ghost native-slides-progress-pick" disabled={!row.pageId} onClick={() => { if (row.pageId) context.onPage(row.pageId); }}>{row.index + 1}. {row.title}</button>
          <span className="native-slides-status" data-status={row.status}>{STATUS_LABELS[row.status]}{row.hasProposal ? '・置き換え案あり' : ''}</span>
          {row.status === 'failed' && <ul className="native-slides-reasons">{row.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
          {row.status === 'failed' && generation.status === 'generating' && <RequestButtons context={context} intent={{ kind: 'pages', keys: [row.key] }} label="このページ" />}
        </li>)}
      </ol>
    </div>}
  </div>;
}

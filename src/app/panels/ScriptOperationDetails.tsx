import { useState } from 'react';
import type { ScriptEditArtifact } from '../../core/scriptEditArtifact';
import { buildCutOrdering } from '../../core/cutOrder';
import { deriveScriptStructurePlan } from '../../core/scriptEditProposal';
import { resolveScriptEditPlan, type ScriptEditModification } from '../../core/scriptEditModification';
import type { SavedScriptEditReview } from '../../server/editorAgentContext';

function Ranges({ label, ranges, fps }: { label: string; ranges: Array<{ start: number; end: number }>; fps: number }) {
  const [visible, setVisible] = useState(20);
  return <details open><summary>{label}（{ranges.length}区間）</summary>
    {!ranges.length && <p>なし</p>}
    <ol>{ranges.slice(0, visible).map((range, index) => <li key={index}>
      {(range.start / fps).toFixed(2)}秒〜{(range.end / fps).toFixed(2)}秒
    </li>)}</ol>
    {ranges.length > visible && <button type="button" onClick={() => setVisible(n => n + 20)}>区間の続きを表示</button>}
  </details>;
}
const asRanges = (ranges: Array<{ originalStart: number; originalEnd: number }>) => ranges.map(r => ({ start: r.originalStart, end: r.originalEnd }));

export function ScriptOperationDetails({ artifact, modification }: { artifact: ScriptEditArtifact; modification?: ScriptEditModification }) {
  const [visible, setVisible] = useState(20);
  const { proposal, input } = artifact;
  const plan = proposal.kind === 'structure' ? deriveScriptStructurePlan(input, proposal) : null;
  const finalPlan = modification ? resolveScriptEditPlan(artifact, modification) : null;
  const nativePlan=input.native&&proposal.kind==='structure'?resolveScriptEditPlan(artifact,modification):null;
  return <details><summary>{proposal.kind === 'caption' ? `台本に合わせる字幕（${proposal.changes.length}件）` : '台本に沿った構成の変更前後'}</summary>
    {proposal.kind === 'caption' && <ol>{proposal.changes.slice(0, visible).map(change => <li key={change.telopId}>
      <p>変更前：{change.before}</p><p>変更案：{change.after}</p>
      {finalPlan?.kind === 'caption' && <p>人が修正した採用内容：{finalPlan.changes.find(c => c.telopId === change.telopId)?.after}</p>}
    </li>)}</ol>}
    {nativePlan?.native?.ranges && <>
      <p>変更前の完成動画の時間で表示しています。選んだ原音の使用区間内で、映像・音声・字幕を番号順に並べます。区間外の前後は保持します。</p>
      <Ranges label={modification?'修正した採用内容の再生順':'変更案の再生順'} fps={input.editing.fps} ranges={nativePlan.native.ranges.map(range=>({start:range.startFrame,end:range.endFrame}))}/>
    </>}
    {plan && !input.native && <>
      <p>元の映像の時間で表示しています。番号順に再生します。</p>
      <Ranges label="変更前の再生順" fps={input.editing.fps} ranges={asRanges(buildCutOrdering(input.editing.totalFrames, input.editing.cutRegions, input.editing.cutOrder).segments)} />
      <Ranges label="変更案の再生順" fps={input.editing.fps} ranges={asRanges(plan.cutOrder)} />
      <Ranges label="変更案でカットする範囲" fps={input.editing.fps} ranges={plan.cutRegions} />
      {finalPlan?.kind === 'structure' && <>
        <Ranges label="人が修正した採用内容の再生順" fps={input.editing.fps} ranges={asRanges(finalPlan.cutOrder)} />
        <Ranges label="人が修正した採用内容でカットする範囲" fps={input.editing.fps} ranges={finalPlan.cutRegions} />
      </>}
    </>}
    <ol aria-label="台本ごとの提案理由">{proposal.passages.slice(0, visible).map(decision => {
      const passage = input.alignment.packet.script.passages.find(p => p.id === decision.passageId)!;
      return <li key={decision.passageId}><p>{input.alignment.packet.script.text.slice(passage.range.start, passage.range.end)}</p>
        <p>{decision.action === 'use' ? '使用する' : '今回は使用しない'}：{decision.reason}</p></li>;
    })}</ol>
    {Math.max(proposal.passages.length, proposal.kind === 'caption' ? proposal.changes.length : 0) > visible
      && <button type="button" onClick={() => setVisible(n => n + 20)}>変更案の続きを表示</button>}
  </details>;
}

export function ScriptSavedStateReview({ inspection }: { inspection: SavedScriptEditReview }) {
  const [visible, setVisible] = useState(20);
  if(inspection.documentFormat==='sequence-v2') {
    const current=inspection.current;
    return <div data-testid="script-saved-state-review">
      <p>取得時点の画面と保存済みの編集全体を照合しました。過去の処理が保存したことの証明ではありません。</p>
      <p>保存内容：{{input:'変更前の内容と一致',proposal:inspection.modified?'人が修正した採用内容と一致':'変更案の内容と一致',diverged:'変更前とも採用内容とも異なります'}[inspection.savedState]}</p>
      <p>映像・音声・字幕・色・位置など、保存した設定を含めて比較しています。素材ファイルそのものの再検証は含みません。</p>
      <details open><summary>保存されている台本</summary><p style={{whiteSpace:'pre-wrap'}}>{current.scriptDocument?.text??'台本はありません'}</p></details>
      <p>動画の長さ：{(current.totalFrames/current.fps).toFixed(2)}秒</p>
      <ol aria-label="保存されているクリップ">{current.clips.slice(0,visible).map(clip=><li key={clip.id}>{clip.name}：{(clip.startFrame/current.fps).toFixed(2)}秒〜{(clip.endFrame/current.fps).toFixed(2)}秒{clip.text!==undefined&&<p>{clip.text}</p>}</li>)}</ol>
      {current.clips.length>visible&&<button type="button" onClick={()=>setVisible(n=>n+20)}>クリップの続きを表示</button>}
    </div>;
  }
  const current = inspection.current;
  const fps = current.fps;
  return <div data-testid="script-saved-state-review">
    <p>取得時点の画面と保存済みの台本・字幕・カット範囲・再生順・元映像の長さを照合しました。過去の処理が保存したことの証明ではありません。</p>
    <p>保存内容：{{ input: '変更前の内容と一致', proposal: inspection.modified ? '人が修正した採用内容と一致' : '変更案の内容と一致', diverged: inspection.modified ? '変更前とも修正した採用内容とも異なります' : '変更前とも変更案とも異なります' }[inspection.savedState]}</p>
    <p>色・音・位置などの設定は、この照合の対象に含めません。</p>
    <details open><summary>保存されている台本</summary><p style={{ whiteSpace: 'pre-wrap' }}>{current.scriptDocument?.text ?? '台本はありません'}</p></details>
    <p>変更前との比較：台本{current.scriptDocumentMatchesInput ? 'は一致' : 'は変更あり'} ／ 字幕{current.telopsMatchInput ? 'は一致' : 'は変更あり'} ／ カット範囲{current.cutRegionsMatchInput ? 'は一致' : 'は変更あり'} ／ 再生順{current.cutOrderMatchInput ? 'は一致' : 'は変更あり'}</p>
    {inspection.kind === 'caption' && <><ol aria-label="対象字幕の保存内容">{current.targetTelops.slice(0, visible).map(target => <li key={target.id}>
      <p>変更前：{target.before}</p><p>変更案：{target.proposedAfter ?? target.after}</p>
      {inspection.modified && <p>人が修正した採用内容：{target.after}</p>}<p>保存内容：{target.current?.text ?? '削除されています'}</p>
      {target.current && <p>{(target.current.originalStart / fps).toFixed(2)}秒〜{(target.current.originalEnd / fps).toFixed(2)}秒</p>}
    </li>)}</ol>{current.targetTelops.length > visible && <button type="button" onClick={() => setVisible(n => n + 20)}>字幕の続きを表示</button>}</>}
    <Ranges label="保存されているカット範囲" fps={fps} ranges={current.cutRegions} />
    <Ranges label="保存されている再生順の指定" fps={fps} ranges={asRanges(current.cutOrder)} />
    {!current.cutOrder.length && <p>再生順の指定はありません。カット後の映像を元の順序で再生します。</p>}
  </div>;
}

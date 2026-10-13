import {useEffect,useState} from 'react';
import {useSilenceCut} from './useSilenceCut';
import {isEscape} from './keyboard';
import type {NativeSession} from './api';
import type {SequenceDocument} from '../../core/sequence/model';
import type {SilenceRange} from '../../shared/silenceCut';
import './native-silence-cut.css';

interface Props {projectId:string;state:NativeSession;read:()=>NativeSession|null;accept:(s:NativeSession)=>void;prepare:()=>Promise<boolean>;blocked:boolean;selection:SilenceRange|null;onBusy:(v:boolean)=>void;onCandidates:(r:SilenceRange[])=>void;onPreview:(d:SequenceDocument|null,start?:number,end?:number)=>void;onClose:()=>void;onFinish:()=>void;onUndo:()=>Promise<unknown>}
const duration=(frames:number,fps:number)=>{const seconds=frames/fps;return seconds>=60?`${Math.floor(seconds/60)}分${(seconds%60).toFixed(1)}秒`:`${seconds.toFixed(1)}秒`;};
export function NativeSilenceCutPanel(props:Props){
  const cut=useSilenceCut(props),[auditionIndex,setAuditionIndex]=useState(0),fps=props.state.document.fps.num/props.state.document.fps.den;
  const disabled=props.blocked||cut.applying||cut.uncertain,ready=cut.plan?.phase==='ready',tracks=props.state.document.tracks.filter(t=>t.kind==='audio'&&props.state.document.clips.some(c=>c.trackId===t.id&&c.content.kind==='audio'&&c.content.role==='speech'));
  useEffect(()=>{if(cut.scope)cut.setScope(props.selection??undefined);},[props.selection]);
  const change=(key:keyof typeof cut.settings,value:number)=>{if(Number.isFinite(value))cut.setSettings(s=>({...s,[key]:value}));};
  return <section className="native-silence-panel" aria-label="無音カットの設定" onKeyDown={event=>{event.stopPropagation();if(isEscape(event.nativeEvent)&&!cut.applying&&!cut.uncertain)props.onClose();}}>
    <header><span className="native-silence-eyebrow">音声のない区間をまとめて短縮</span><button type="button" className="btn-ghost" disabled={cut.applying||cut.uncertain} onClick={props.onClose}>閉じる</button></header>
    <div className="native-silence-settings">
    <p className="native-subtle">カットした部分は保存され、あとから戻せます。</p>
    <fieldset disabled={disabled}><legend>カットの強さ</legend><div className="native-silence-range-label"><span>少なめ</span><span>多め</span></div><input aria-label="カットの強さ" type="range" min={-80} max={-10} step={1} value={cut.settings.thresholdDb} onChange={e=>change('thresholdDb',e.target.valueAsNumber)}/>
      <label className="native-silence-number">無音とみなす音量<span><input aria-label="無音とみなす音量" type="number" min={-80} max={-10} step={1} value={cut.settings.thresholdDb} onChange={e=>change('thresholdDb',e.target.valueAsNumber)}/> dB</span></label>
      <label className="native-silence-number">この長さ以上の無音<span><input aria-label="最小無音長" type="number" min={.05} max={10} step={.05} value={cut.settings.minSilenceSeconds} onChange={e=>change('minSilenceSeconds',e.target.valueAsNumber)}/> 秒</span></label>
      <details><summary>詳細設定</summary><label className="native-silence-number">話し始めの前に残す<span><input aria-label="発話前の余白" type="number" min={0} max={2} step={.01} value={cut.settings.beforeSeconds} onChange={e=>change('beforeSeconds',e.target.valueAsNumber)}/> 秒</span></label><label className="native-silence-number">話し終わりの後に残す<span><input aria-label="発話後の余白" type="number" min={0} max={2} step={.01} value={cut.settings.afterSeconds} onChange={e=>change('afterSeconds',e.target.valueAsNumber)}/> 秒</span></label></details>
    </fieldset>
    <details open={tracks.length!==1}><summary>対象音声・範囲</summary>
    <fieldset disabled={disabled}><legend>対象音声</legend>{tracks.length?tracks.map(t=><label className="native-silence-track" key={t.id}><input type="checkbox" checked={cut.tracks.includes(t.id)} onChange={e=>cut.setTracks(ids=>e.target.checked?[...ids,t.id]:ids.filter(id=>id!==t.id))}/>{t.name}</label>):<p>主音声を追加してください。</p>}
      <small>元の音声の音量で判定します。BGM・効果音は対象外。</small>{cut.tracks.length>1&&<small>選んだ音声がすべて静かな区間をカットします。</small>}
    </fieldset>
    <label className="native-silence-field">対象範囲<select disabled={disabled} value={cut.scope?'selection':'all'} onChange={e=>cut.setScope(e.target.value==='all'?undefined:props.selection??undefined)}><option value="all">動画全体</option><option value="selection" disabled={!props.selection}>選択範囲</option></select></label>
    </details>
      {!!cut.plan?.ranges.length&&<><label className="native-silence-number">試聴する箇所<span><input aria-label="試聴する箇所" type="number" min={1} max={cut.plan.ranges.length} step={1} disabled={!ready||disabled} value={Math.min(auditionIndex+1,cut.plan.ranges.length)} onChange={e=>{const n=e.target.valueAsNumber;if(Number.isInteger(n))setAuditionIndex(Math.max(0,Math.min(cut.plan!.ranges.length-1,n-1)));}}/> / {cut.plan.ranges.length}</span></label><button disabled={!ready||disabled} onClick={()=>void cut.audition(Math.min(auditionIndex,cut.plan!.ranges.length-1))}>つなぎ目を試聴</button><button onClick={()=>props.onPreview(null)}>試聴を終了</button></>}
    </div>
    <div className="native-silence-result" role="status" aria-live="polite">
      {!cut.started?<><strong>無音区間を解析</strong><span>解析を開始すると、タイムラインに候補が表示されます。</span></>:cut.error&&!cut.plan?<strong>解析を完了できませんでした</strong>:cut.applying?<strong>カットを適用中…</strong>:cut.applied?<><strong>{cut.applied.count}か所をカットしました</strong><span>{duration(cut.applied.frames,fps)}短縮</span></>:cut.plan?<><strong>{cut.plan.ranges.length}か所 · {duration(cut.plan.removedFrames,fps)}を短縮{ready?'予定':'候補'}</strong><span>{duration(props.state.document.sequenceEndFrame,fps)} → {duration(cut.plan.resultFrames,fps)}</span><small>タイムラインのオレンジの網掛けが候補です（未適用）。</small>{cut.plan.phase==='checking'&&<small>配置と復元を確認中…</small>}{!cut.plan.ranges.length&&<small>この設定でカットできる無音はありません。</small>}</>:cut.status?.phase==='analyzing'?<><strong>音声を解析中… {Math.round(cut.status.percent)}%</strong><progress max={100} value={cut.status.percent}/></>:<span>{cut.tracks.length?(cut.status?.phase==='completed'?'候補を更新中…':'音声を解析中…'):'対象音声を選んでください'}</span>}
    </div>
    {cut.error&&<p className="native-silence-error" role="alert">{cut.error}</p>}
    {cut.applied?<div className="native-silence-actions"><button onClick={props.onFinish}>仕上げで確認</button>{cut.canUndo&&<button disabled={props.blocked} onClick={()=>void props.onUndo()}>今回のカットを取り消す</button>}<button disabled={disabled} onClick={cut.reanalyze}>残っている区間を解析</button></div>:<div className="native-silence-actions">

      {!cut.started?<button className="btn-primary" disabled={props.blocked||!cut.tracks.length} onClick={cut.reanalyze}>解析開始</button>:<button className="btn-primary" disabled={cut.applying||props.blocked||!cut.uncertain&&(!ready||!cut.plan?.ranges.length)} onClick={()=>void cut.apply()}>{cut.uncertain?'結果を再確認':`${cut.plan?.ranges.length??0}か所を一括カット`}</button>}
      {cut.error&&!cut.uncertain&&<button disabled={cut.applying} onClick={cut.reanalyze}>再解析</button>}
    </div>}
  </section>;
}

import {useRef,useState} from 'react';
import type {SequenceDocument} from '../../core/sequence/model';
import type {NativeCommand} from './api';
import {sceneFadeJoins,sceneFadeTargetKey,resolveSceneFade,sceneFadeIssue,type SceneFadeTarget,type SceneFadeChange} from '../../core/sequence/sceneFadeEdits';
import {timeNumber} from '../../core/sequence/time';
import {ColorField,NumberField,SelectField} from './NativeInspectorFields';
import {SCENE_COLORS,DEFAULT_SCENE_COLOR} from '../../core/transitionStyle';

interface Props {document:SequenceDocument;target:SceneFadeTarget;disabled:boolean;onTarget(target:SceneFadeTarget):Promise<boolean>;onEdit(build:(document:SequenceDocument)=>NativeCommand):Promise<boolean>}
export function NativeSceneFadeSettings({document:doc,target,disabled,onTarget,onEdit}:Props){
  const [switching,setSwitching]=useState(false),switchPending=useRef(false),element=useRef<HTMLFieldSetElement>(null);
  const selectTarget=async(next:SceneFadeTarget)=>{
    if(switchPending.current)return false;
    switchPending.current=true;
    // Commit the focused old field while it is still enabled. Disabling first
    // can suppress its blur in Chromium before the parent's async flush runs.
    const active=window.document.activeElement;
    if(active instanceof HTMLElement&&element.current?.contains(active))active.blur();
    setSwitching(true);
    try{return await onTarget(next);}
    finally{switchPending.current=false;setSwitching(false);}
  };
  const fades=doc.clips.filter(c=>c.content.kind==='scene-fade');
  const fadeLabel=(c:typeof fades[number])=>`既存の場面フェード ${fades.indexOf(c)+1} · ${c.name}（開始 ${c.startFrame}fr・長さ ${c.durationFrames}fr）`;
  const joins=sceneFadeJoins(doc),options=[{value:'head',label:'動画の最初',target:{kind:'head'} as SceneFadeTarget},{value:'tail',label:'動画の最後',target:{kind:'tail'} as SceneFadeTarget},
    ...joins.map(j=>({value:sceneFadeTargetKey(j.target),label:j.label,target:j.target})),
    ...fades.map(c=>({value:sceneFadeTargetKey({kind:'clip',clipId:c.id}),label:fadeLabel(c),target:{kind:'clip' as const,clipId:c.id}}))];
  let resolved:ReturnType<typeof resolveSceneFade>|undefined,problem='';
  try{resolved=resolveSceneFade(doc,target);}catch(error){problem=error instanceof Error?error.message:'対象を選び直してください';}
  const clip=resolved?.clip,color=clip?.content.kind==='scene-fade'?clip.content.color:'#000000';
  const kind=!clip?'none':color.toLowerCase()==='#000000'?'fadeBlack':color.toLowerCase()==='#ffffff'?'fadeWhite':'fadeColor';
  const issue=clip?sceneFadeIssue(clip):null,duration=clip?timeNumber(clip.clock.duration):15;
  const apply=(change:SceneFadeChange)=>onEdit(()=>({type:'set-scene-fades',targets:[target],change}));
  const changeKind=async(value:string)=>{
    const ok=await apply(value==='none'?{enabled:false}:{enabled:true,color:value==='fadeBlack'?'#000000':value==='fadeWhite'?'#FFFFFF':DEFAULT_SCENE_COLOR});
    if(ok&&value==='none'&&target.kind==='clip')await selectTarget({kind:'head'});
    return ok;
  };
  const trackId=target.kind==='join'?target.trackId:null,targets=joins.filter(j=>j.target.trackId===trackId).map(j=>j.target);
  const displaced=resolved?.displaced??[],shared=target.kind==='join'&&joins.filter(j=>j.frame===timeNumber(resolved?.frame??{num:0,den:1})).length>1;
  const applyAll=()=>{
    const expected=targets.map(sceneFadeTargetKey).join('|');
    void onEdit(current=>{
      const now=sceneFadeJoins(current).filter(j=>j.target.trackId===trackId).map(j=>j.target);
      if(now.map(sceneFadeTargetKey).join('|')!==expected)throw new Error('つなぎ目の一覧が変わりました。対象を選び直してください。');
      const currentFade=resolveSceneFade(current,target).clip;
      if(!currentFade)return {type:'set-scene-fades',targets:now,change:{enabled:false}};
      if(currentFade.content.kind!=='scene-fade'||sceneFadeIssue(currentFade))throw new Error('標準外のフェードは一括適用できません。');
      return {type:'set-scene-fades',targets:now,change:{enabled:true,color:currentFade.content.color,durationFrames:timeNumber(currentFade.clock.duration)}};
    }).catch(()=>{});
  };
  return <fieldset ref={element} className="native-scene-fade-settings" disabled={disabled||switching} aria-busy={switching}><section><h3>映像の切替</h3>
    <p className="native-subtle">映像全体を色で切り替えます。音声と動画の長さは変わりません。</p>
    <SelectField label="フェードの対象" value={sceneFadeTargetKey(target)} onCommit={value=>{const option=options.find(o=>o.value===value);return option?selectTarget(option.target):Promise.resolve(false);}}>{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</SelectField>
    {shared&&<p className="native-subtle">同じ時刻の他トラックのつなぎ目にも、この1枚のフェードが共通で使われます。</p>}
    {problem?<p role="alert">{problem}</p>:displaced.length>0?<>
      <p role="status">位置がずれた既存のフェードがあります。重ねて追加する前に、既存のフェードを確認してください。</p>
      {displaced.map(c=><div key={c.id}><span>{fadeLabel(c)}</span>
        <button onClick={()=>{void selectTarget({kind:'clip',clipId:c.id});}}>このフェードを選択</button>
        {!sceneFadeIssue(c)&&<button onClick={()=>{void apply({enabled:true,moveFromClipId:c.id}).catch(()=>{});}}>この位置へ移す</button>}
      </div>)}
      <button onClick={()=>{void apply({enabled:true,newAtTarget:true}).catch(()=>{});}}>ここに新しいフェードを追加</button>
    </>:<>
      <SelectField label="フェードの種類" value={kind} onCommit={changeKind}><option value="none">なし</option><option value="fadeBlack">フェード（暗転）</option><option value="fadeWhite">フェード（白転）</option><option value="fadeColor">フェード（色指定）</option></SelectField>
      {clip&&<>{issue?<p className="native-subtle">{issue}</p>:<NumberField label="フェードの長さ（fr）" value={duration} min={2} step={1} onCommit={value=>apply({durationFrames:Math.round(value)})}/>}
        {(kind==='fadeColor'||issue)&&<><ColorField label="フェードの色" value={color} onCommit={value=>apply({color:value})}/><div className="native-scene-fade-colors">{SCENE_COLORS.map(value=><button key={value} aria-label={`フェードの色 ${value}`} aria-pressed={color.toLowerCase()===value.toLowerCase()} style={{background:value}} onClick={()=>{void apply({color:value}).catch(()=>{});}}/>)}</div></>}
        <button onClick={()=>{void changeKind('none').catch(()=>{});}}>このフェードを解除</button>
      </>}
      {trackId&&targets.length>0&&<button disabled={!!issue} onClick={applyAll}>{kind==='none'?`このトラックの全つなぎ目を解除（${targets.length}件）`:`このトラックの全つなぎ目に適用（${targets.length}件）`}</button>}
    </>}
    <p className="native-subtle">フェードは設定時の位置に置きます。重なりによる切替や速度変更は、ここでは変更しません。</p>
  </section></fieldset>;
}

import {useRef,useState} from 'react';
import {applySequenceCommand,type SequenceCommand} from '../../core/sequence/commands';
import type {SequenceDocument,TransitionKind} from '../../core/sequence/model';
import type {NativeCommand} from './api';
import {resolveSceneFade,type SceneFadeTarget} from '../../core/sequence/sceneFadeEdits';
import {planTransition,transitionJoinsForUi,transitionRoom,type OverlapTransitionKind,type TransitionJoin} from '../../core/sequence/transitions';
import {timeNumber} from '../../core/sequence/time';
import {NumberField,SelectField} from './NativeInspectorFields';
import {SCENE_COLORS,DEFAULT_SCENE_COLOR} from '../../core/transitionStyle';

type UiKind='none'|'fadeBlack'|'fadeWhite'|'fadeColor'|'crossfade'|'slide'|'wipe';
type Direction='Left'|'Right'|'Up'|'Down';
const KIND_LABELS:Array<[UiKind,string]>=[['none','なし'],['fadeBlack','フェード（暗転）'],['fadeWhite','フェード（白転）'],
  ['fadeColor','フェード（色指定）'],['crossfade','クロスフェード'],['slide','スライド'],['wipe','ワイプ']];
const DIRECTIONS:Array<[Direction,string]>=[['Left','左へ'],['Right','右へ'],['Up','上へ'],['Down','下へ']];
/** 2 クリップを重ねる種類。単色フェードは重なりを使わず場面フェード（scene-fade クリップ）で表す。 */
const OVERLAP:UiKind[]=['crossfade','slide','wipe'];
const MIN_FRAMES=2,MAX_FRAMES=60,DEFAULT_FRAMES=15;
const NO_HANDLES='このつなぎ目は、転換に使える元素材が足りないため重ねられません。片側のクリップを短くしてください。';
const TOO_SHORT='このつなぎ目は、両側のクリップが短いため重ねられません。クリップを長くするか、転換を短くしてください。';
const SPEED_REGISTERED='速度を設定した案件では転換を付けられません。先に速度を全体へ戻してください。';

const overlapKind=(ui:UiKind,direction:Direction):OverlapTransitionKind=>
  ui==='slide'?`slide${direction}`:ui==='wipe'?`wipe${direction}`:'crossfade';
const directionOf=(kind:TransitionKind):Direction|null=>{
  const rest=kind.startsWith('slide')?kind.slice(5):kind.startsWith('wipe')?kind.slice(4):'';
  return rest==='Left'||rest==='Right'||rest==='Up'||rest==='Down'?rest:null;
};
const clamp=(frames:number)=>Math.min(MAX_FRAMES,Math.max(MIN_FRAMES,Math.round(frames)));
/** 単色フェード（場面フェード）経路には 60fr の重なり上限を掛けない。場面フェード欄と同じ下限だけの丸め。 */
const clampFade=(frames:number)=>Math.max(MIN_FRAMES,Math.round(frames));
const fadeTargetOf=(join:TransitionJoin):SceneFadeTarget=>({kind:'join',trackId:join.trackId,outClipId:join.outClipId,inClipId:join.inClipId});
function fadeClipAt(doc:SequenceDocument,join:TransitionJoin){
  try{return resolveSceneFade(doc,fadeTargetOf(join)).clip;}catch{return undefined;}
}

interface Props {document:SequenceDocument;joinKey:string;disabled:boolean;
  onJoin(joinKey:string):Promise<boolean>;onEdit(build:(document:SequenceDocument)=>NativeCommand):Promise<boolean>}

/**
 * 仕上げモードの「シーン転換」。時間モデルと排他は T0c の `set-transition` が持ち、ここは
 * 選択と件数だけを扱う。重なり（クロスフェード・スライド・ワイプ）は `set-transition`、
 * 単色フェード（暗転・白転・色指定）は `set-scene-fades` へ振り分け、種類をまたぐ切替は
 * batch 1 本（Undo 1 回）にまとめる。
 */
export function NativeTransitionSettings({document:doc,joinKey,disabled,onJoin,onEdit}:Props){
  const element=useRef<HTMLFieldSetElement>(null);
  const joins=transitionJoinsForUi(doc),join=joins.find(item=>item.joinKey===joinKey);
  const current=doc.transitions.find(item=>item.joinKey===joinKey&&item.inClipId!==undefined);
  const fade=current||!join?undefined:fadeClipAt(doc,join);
  const fadeColor=fade?.content.kind==='scene-fade'?fade.content.color:DEFAULT_SCENE_COLOR;
  const documentUi:UiKind=current?(current.kind.startsWith('slide')?'slide':current.kind.startsWith('wipe')?'wipe':'crossfade')
    :fade?(fadeColor.toLowerCase()==='#000000'?'fadeBlack':fadeColor.toLowerCase()==='#ffffff'?'fadeWhite':'fadeColor'):'none';
  // 選択直後は文書がまだ変わっていない。文書の状態が動いた時点で選択の記憶を捨てる。
  const [choice,setChoice]=useState<{kind:UiKind;from:UiKind}|null>(null);
  const ui=choice&&choice.from===documentUi?choice.kind:documentUi;
  const [direction,setDirection]=useState<Direction>(()=>(current&&directionOf(current.kind))||'Left');
  const duration=current?.durationFrames??(fade?Math.round(timeNumber(fade.clock.duration)):DEFAULT_FRAMES);
  const out=doc.clips.find(clip=>clip.id===join?.outClipId),incoming=doc.clips.find(clip=>clip.id===join?.inClipId);
  // 速度を登録したクリップは set-transition が拒否する（T0c I5）。
  const speedRegistered=out?.speed!==undefined||incoming?.speed!==undefined;
  const capacity=(()=>{
    if(!join)return {max:0,error:'NO_JOIN' as const};
    try{const planned=planTransition(doc,joinKey,'crossfade',MAX_FRAMES);
      return 'error' in planned?{max:0,error:planned.error}:{max:planned.before+planned.after,error:null};}
    catch{return {max:0,error:'NO_JOIN' as const};}
  })();
  // 置換時の余白は planTransition と同じ補正で見せる（core の transitionRoom を使う）。
  const room=join?(()=>{try{return transitionRoom(doc,joinKey);}catch{return {outHandle:0,inHandle:0};}})():{outHandle:0,inHandle:0};
  const overlapBlocked=speedRegistered||capacity.max<MIN_FRAMES;
  const blockedReason=speedRegistered?SPEED_REGISTERED:capacity.error==='CLIPS_TOO_SHORT'?TOO_SHORT:NO_HANDLES;
  const legacy=doc.transitions.filter(item=>item.inClipId!==undefined&&(item.joinKey===undefined||item.joinFrame===undefined));

  /** 1 つのつなぎ目に対する最小のコマンド列。渡した文書の状態だけを見て組み立てる。 */
  function joinCommands(document:SequenceDocument,item:TransitionJoin,next:UiKind,frames:number,color?:string,facing=direction):SequenceCommand[]{
    const key=item.joinKey,target=fadeTargetOf(item);
    const overlap=document.transitions.find(entry=>entry.joinKey===key&&entry.inClipId!==undefined);
    if(next==='none'){
      // 重なりがある間は境界が隙間なしではないので、場面フェードの有無は解除後にしか見られない。
      if(overlap)return [{type:'set-transition',joinKey:key,transition:null}];
      return fadeClipAt(document,item)?[{type:'set-scene-fades',targets:[target],change:{enabled:false}}]:[];
    }
    if(OVERLAP.includes(next)){
      const planned=planTransition(document,key,overlapKind(next,facing),clamp(frames));
      if('error' in planned)throw new Error(planned.error==='NO_HANDLES'?NO_HANDLES:TOO_SHORT);
      // 場面フェードとの排他は set-transition 側が行う（T0c）。ここで解除コマンドを足さない。
      return [{type:'set-transition',joinKey:key,transition:planned.transition}];
    }
    const chosen=next==='fadeBlack'?'#000000':next==='fadeWhite'?'#FFFFFF':color;
    return [...(overlap?[{type:'set-transition' as const,joinKey:key,transition:null}]:[]),
      {type:'set-scene-fades',targets:[target],change:{enabled:true,durationFrames:clampFade(frames),...(chosen?{color:chosen}:{})}}];
  }
  const single=(commands:SequenceCommand[]):NativeCommand=>{
    if(!commands.length)throw new Error('このつなぎ目には転換が付いていません。');
    return commands.length===1?commands[0]!:{type:'batch',commands};
  };
  const [clampedNote,setClampedNote]=useState(false);
  const apply=(next:UiKind,frames=duration,color?:string,facing=direction)=>{
    let clamped=false;
    return onEdit(document=>{
      const item=transitionJoinsForUi(document).find(entry=>entry.joinKey===joinKey);
      if(!item)throw new Error('つなぎ目が変わりました。対象を選び直してください。');
      if(speedRegistered&&OVERLAP.includes(next))throw new Error(SPEED_REGISTERED);
      if(OVERLAP.includes(next)){
        const planned=planTransition(document,item.joinKey,overlapKind(next,facing),clamp(frames));
        if(!('error' in planned))clamped=planned.clamped;
      }
      return single(joinCommands(document,item,next,frames,color,facing));
    }).then(ok=>{setClampedNote(ok&&clamped);return ok;});
  };
  const changeKind=async(value:string)=>{
    const next=value as UiKind;setChoice({kind:next,from:documentUi});
    let ok=false;
    try{
      ok=await apply(next,duration,next==='fadeColor'?(documentUi==='fadeColor'?fadeColor:DEFAULT_SCENE_COLOR):undefined);
      return ok;
    }finally{
      // apply が reject（build の throw）した時も、種類欄は文書の実際の値へ戻す（成功時は文書が
      // 動いた時点で choice を捨てたいので、ここでは失敗時だけ即座に戻す）。
      if(!ok)setChoice(null);
    }
  };
  const trackJoins=join?joins.filter(item=>item.trackId===join.trackId):[];
  const applyAll=()=>{
    const expected=trackJoins.map(item=>item.joinKey).join('|'),trackId=join?.trackId;
    void onEdit(document=>{
      const now=transitionJoinsForUi(document).filter(item=>item.trackId===trackId);
      if(now.map(item=>item.joinKey).join('|')!==expected)throw new Error('つなぎ目の一覧が変わりました。対象を選び直してください。');
      // batch は順に適用される。後のつなぎ目の計画が古い状態で作られないよう、途中経過へ順に当てながら組む。
      let projected=document;const commands:SequenceCommand[]=[];
      for(const item of now){
        try{
          const built=joinCommands(projected,item,ui,duration,ui==='fadeColor'?fadeColor:undefined);
          for(const command of built)projected=applySequenceCommand(projected,command);
          commands.push(...built);
        }catch{/* 余白が足りないつなぎ目は除外する。0 件なら下で明示的に失敗させる。 */}
      }
      if(!commands.length)throw new Error(ui==='none'?'解除できるつなぎ目がありません。'
        :'適用できるつなぎ目がありません。元素材の余りがあるつなぎ目を選んでください。');
      return commands.length===1?commands[0]!:{type:'batch',commands};
    }).catch(()=>{});
  };
  const selectJoin=(value:string)=>{
    // 編集中の欄は、無効化される前に確定させる（場面フェード欄と同じ手順）。
    const active=window.document.activeElement;
    if(active instanceof HTMLElement&&element.current?.contains(active))active.blur();
    return onJoin(value);
  };
  return <fieldset ref={element} className="native-transition-settings" disabled={disabled}><section><h3>シーン転換</h3>
    <p className="native-subtle">つなぎ目を中心に重ねて切り替えます。全体の長さは変わりません。</p>
    <SelectField label="転換のつなぎ目" value={join?joinKey:''} onCommit={selectJoin}>
      {joins.length?joins.map(item=><option key={item.joinKey} value={item.joinKey}>{item.label}</option>)
        :<option value="">つなぎ目がありません</option>}
    </SelectField>
    {legacy.length>0&&<p role="status">以前の形式で保存された転換が {legacy.length} 件あります。この画面からは解除できません。</p>}
    {!join?<p role="status">このトラックには、転換を付けられるつなぎ目がありません。</p>:<>
      {speedRegistered&&<p role="status">{SPEED_REGISTERED}案件全体の「速度」で全体へ戻せます。</p>}
      {!speedRegistered&&capacity.error==='NO_HANDLES'&&<p role="status">{NO_HANDLES}</p>}
      {!speedRegistered&&capacity.error==='CLIPS_TOO_SHORT'&&<p role="status">{TOO_SHORT}</p>}
      {!current&&fade&&<p role="status">このつなぎ目には場面フェードが付いています。重なる転換を選ぶと置き換わります。</p>}
      <p className="native-subtle">使える元素材（余白）: 前 {room.outHandle}fr・後 {room.inHandle}fr{capacity.max>=MIN_FRAMES?`（重なりは最大 ${capacity.max}fr）`:''}</p>
      <SelectField label="転換の種類" value={ui} onCommit={changeKind}>
        {KIND_LABELS.map(([value,label])=>{const blocked=overlapBlocked&&OVERLAP.includes(value);
          return <option key={value} value={value} disabled={blocked} title={blocked?blockedReason:undefined}>{label}</option>;})}
      </SelectField>
      {(ui==='slide'||ui==='wipe')&&<SelectField label="転換の方向" value={direction} onCommit={value=>{
        const next=value as Direction;setDirection(next);return apply(ui,duration,undefined,next);
      }}>{DIRECTIONS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</SelectField>}
      {ui!=='none'&&<>
        <NumberField label="転換の長さ（fr）" value={duration} min={MIN_FRAMES}
          max={OVERLAP.includes(ui)?Math.min(MAX_FRAMES,Math.max(MIN_FRAMES,capacity.max)):undefined} step={1}
          onCommit={value=>apply(ui,value,ui==='fadeColor'?fadeColor:undefined)}/>
        {clampedNote&&<p className="native-subtle">余白に合わせて {duration}fr に調整しました。</p>}
        {ui==='fadeColor'&&<div className="native-scene-fade-colors">{SCENE_COLORS.map(value=>
          <button key={value} type="button" aria-label={`転換の色 ${value}`} aria-pressed={fadeColor.toLowerCase()===value.toLowerCase()}
            style={{background:value}} onClick={()=>{void apply('fadeColor',duration,value).catch(()=>{});}}/>)}</div>}
        <button type="button" onClick={()=>{void apply('none').catch(()=>{});}}>この転換を解除</button>
        {current&&<p className="native-subtle">転換が付いたクリップの移動・分割は、先に転換を解除してから行ってください。</p>}
        {current&&<p className="native-subtle">音声は映像に合わせて自然に混ざります。結び付いた音声クリップは伸びません（映像だけが重なります）。</p>}
      </>}
      {trackJoins.length>0&&<button type="button" onClick={applyAll}
        aria-label={ui==='none'?`このトラックの全つなぎ目の転換を解除（${trackJoins.length}件）`:`このトラックの全つなぎ目へ転換を適用（${trackJoins.length}件）`}>
        {ui==='none'?'全つなぎ目を解除':'全つなぎ目へ適用'}<kbd className="native-key native-count" aria-hidden="true">{trackJoins.length}</kbd></button>}
    </>}
  </section></fieldset>;
}

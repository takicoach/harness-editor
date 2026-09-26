import {useState} from 'react';
import type {SequenceClip,SequenceDocument} from '../../core/sequence/model';
import {timeNumber} from '../../core/sequence/time';
import type {NativeCommand} from './api';
import {ValidatedTextField,SelectField} from './NativeInspectorFields';
import {parseSpeedInput,speedInputValue,speedRegistrationOptions,registrationCommand,speedUnavailableMessage} from './speedSettings';
import {NativeSpeedScale} from './NativeSpeedScale';
import {insertOwnRegistrationIssue} from '../../core/sequence/insertOwnSpeed';
type Edit=(build:(document:SequenceDocument)=>NativeCommand)=>Promise<boolean>;
interface Props {document:SequenceDocument;selected:string[];disabled:boolean;onEdit:Edit;onAction:Edit}
export function NativeGlobalSpeedSettings({document:doc,selected,disabled,onEdit,onAction}:Props){
 const options=doc.speed?[]:speedRegistrationOptions(doc),[picked,setPicked]=useState(()=>selected.filter(id=>options.some(o=>o.clip.id===id&&!o.issue)));
 const main=doc.clips.filter(c=>c.speed?.kind==='main');
 return <fieldset className="native-speed-settings" disabled={disabled}><section><h3>全体の速度</h3>
  {!doc.speed?<>
   <p className="native-subtle">速度に連動させる映像を選んでください。登録だけでは、素材の時刻や動画の長さは変わりません。</p>
   {!!doc.cutArchive?.entries.some(entry=>!entry.speed)&&<p className="native-subtle">カット前の区間も速度に連動して戻すには、同じ使用箇所から残った映像をすべて選んで登録してください。片側だけを登録した場合は、登録をUndoして選び直せます。使用箇所が残っていない帯は自動で結び付けません。</p>}
   {!options.length&&<p className="native-subtle">{speedUnavailableMessage(doc)}</p>}
   <div className="native-speed-options">{options.map(({clip,audio,issue})=><div key={clip.id}>
    <label className="native-check"><input type="checkbox" checked={picked.includes(clip.id)} disabled={!!issue} onChange={event=>setPicked(ids=>event.target.checked?[...ids,clip.id]:ids.filter(id=>id!==clip.id))}/><span>{clip.name} <small>{(clip.startFrame/timeNumber(doc.fps)).toFixed(2)}〜{((clip.startFrame+clip.durationFrames)/timeNumber(doc.fps)).toFixed(2)}秒</small></span></label>
    {issue?<p className="native-subtle">{issue}</p>:<p className="native-subtle">{audio.length?`一緒に連動する原音：${audio.map(a=>a.name).join('、')}`:'連動する原音なし'}</p>}
   </div>)}</div>
   <button disabled={!picked.length} onClick={()=>{const ids=[...picked],groupId=crypto.randomUUID();void onAction(current=>registrationCommand(current,ids,groupId)).catch(()=>{});}}>選んだ映像と原音を登録</button>
  </>:doc.speed.family!=='native-exact-v1'?<p className="native-subtle">この速度方式は、この画面から変更できません。</p>:!main.length?<p className="native-subtle">連動する主映像が削除されています。全体の速度は変更できません。</p>:<>
   <p className="native-subtle">登録した{main.length}個の映像と原音に適用します。個別指定のクリップと、連動しない素材の速度は変わりません。</p>
   <NativeSpeedScale rate={timeNumber(doc.speed.globalRate)} disabled={disabled} scope="全体"
     onPick={value=>void onEdit(()=>({type:'set-native-global-speed',rate:parseSpeedInput(String(value))})).catch(()=>{})}/>
   <ValidatedTextField label="全体の倍率" value={speedInputValue(doc.speed.globalRate)} validate={parseSpeedInput} hint="0.1〜16倍。小数または分数で指定できます。" onCommit={text=>onEdit(()=>({type:'set-native-global-speed',rate:parseSpeedInput(text)}))}/>
  </>}
 </section></fieldset>;
}
export function NativeClipSpeedSettings({document:doc,clip,onEdit,onAction}:{document:SequenceDocument;clip:SequenceClip;onEdit:Edit;onAction:Edit}){
 const speed=clip.speed,content=clip.content;
 if(content.kind!=='video'&&content.kind!=='audio')return null;
 if(speed?.kind==='main'&&doc.speed){
  const explicit=speed.override!==undefined,effective=speed.override??doc.speed.globalRate;
  return <section className="native-speed-settings"><h3>再生速度</h3><p className="native-subtle">実効倍率：{speedInputValue(effective)}倍</p>
   <SelectField label="速度の指定" value={explicit?'override':'global'} onCommit={value=>onAction(current=>{const now=current.clips.find(c=>c.id===clip.id);if(now?.speed?.kind!=='main'||!current.speed)throw new Error('対象の映像を選び直してください。');return value==='global'?{type:'reset-native-main-speed',clipId:clip.id}:{type:'set-native-main-speed',clipId:clip.id,rate:now.speed.override??current.speed.globalRate};})}><option value="global">全体の速度に連動</option><option value="override">このクリップだけ指定</option></SelectField>
   {explicit&&<><NativeSpeedScale rate={timeNumber(effective)} scope="このクリップ" onPick={value=>void onEdit(()=>({type:'set-native-main-speed',clipId:clip.id,rate:parseSpeedInput(String(value))})).catch(()=>{})}/><ValidatedTextField label="このクリップの倍率" value={speedInputValue(effective)} validate={parseSpeedInput} onCommit={text=>onEdit(()=>({type:'set-native-main-speed',clipId:clip.id,rate:parseSpeedInput(text)}))}/><button onClick={()=>{void onAction(()=>({type:'reset-native-main-speed',clipId:clip.id})).catch(()=>{});}}>全体へ戻す</button></>}
  </section>;
 }
 const provider=speed?.kind==='main-audio'?doc.clips.find(c=>c.id===speed.providerId):null;
 if(!speed){
  const own=clip.insertOwnSpeed,issue=insertOwnRegistrationIssue(doc,clip);
  return <section className="native-speed-settings"><h3>再生速度</h3>
   <p className="native-subtle">全体の速度に連動していません。{clip.linkGroupId?'編集リンクの映像と原音を一緒に変更します。':'この素材だけを変更します。'}</p>
   {own?<ValidatedTextField label="挿入素材の倍率" value={speedInputValue(own.rate)} validate={parseSpeedInput} hint="0.1〜16倍。素材の開始位置を保って長さを変えます。" onCommit={text=>onEdit(()=>({type:'set-native-insert-own-speed',clipId:clip.id,rate:parseSpeedInput(text),linked:true}))}/>:<>
    <p className="native-subtle">現在の倍率：{speedInputValue(content.rate)}倍</p>
    {issue?<p className="native-subtle">{issue}</p>:<button onClick={()=>{void onAction(()=>({type:'register-native-insert-own-speed',clipId:clip.id,linked:true})).catch(()=>{});}}>この素材の速度を設定</button>}
   </>}
  </section>;
 }
 return <section className="native-speed-settings"><h3>再生速度</h3><p className="native-subtle">現在の倍率：{speedInputValue(content.rate)}倍。{provider?`「${provider.name}」の速度に連動します。映像を選んで変更してください。`:'この素材は全体の速度に連動していません。'}</p></section>;
}

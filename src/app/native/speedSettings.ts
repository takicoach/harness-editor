import {type Rational,rational,rationalFromDecimal,compareTime} from '../../core/sequence/time';
import {nativeSpeedRate} from '../../core/sequence/speedCommandValidation';
import type {SequenceDocument,SequenceClip} from '../../core/sequence/model';

/** Keep the input text until exact conversion; never round through a Number. */
export function parseSpeedInput(text:string):Rational {
 const raw=text.trim();if(!raw)throw new Error('倍率を入力してください（0.1〜16）。');
 try {
  const fraction=/^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  return nativeSpeedRate(fraction?rational(Number(fraction[1]),Number(fraction[2])):rationalFromDecimal(raw));
 }catch{throw new Error('倍率は0.1〜16の小数または分数で入力してください。正確に保存できない桁数の値は使えません。');}
}
/** Exact finite decimals; otherwise show the saved fraction, never a rounded draft. */
export function speedInputValue(value:Rational):string {
 const v=rational(value.num,value.den);let d=BigInt(v.den),twos=0,fives=0;
 while(d%2n===0n){d/=2n;twos++;}while(d%5n===0n){d/=5n;fives++;}
 if(d!==1n)return `${v.num}/${v.den}`;
 const places=Math.max(twos,fives),scaled=BigInt(v.num)*2n**BigInt(places-twos)*5n**BigInt(places-fives);
 if(!places)return String(scaled);const digits=String(scaled).padStart(places+1,'0');
 return `${digits.slice(0,-places)}.${digits.slice(-places)}`.replace(/0+$/,'').replace(/\.$/,'');
}
export interface SpeedRegistrationOption {clip:SequenceClip;audio:SequenceClip[];issue:string|null}
/** Explain global speed's video dependency in the context of the current project. */
export function speedUnavailableMessage(doc:SequenceDocument):string{
 const video=doc.clips.some(c=>c.content.kind==='video'),speech=doc.clips.some(c=>c.content.kind==='audio'&&c.content.role==='speech');
 return !video&&speech?'音声だけの作品では使えません。全体の速度は、映像のクリップに連動させる機能です。':'登録できる映像がありません。映像素材を追加してください。';
}
export function speedRegistrationOptions(doc:SequenceDocument):SpeedRegistrationOption[]{
 const groups=new Map<string,SequenceClip[]>(),order=new Map(doc.clips.map((c,i)=>[c.id,i]));
 for(const clip of doc.clips)if(clip.linkGroupId){const group=groups.get(clip.linkGroupId)??[];group.push(clip);groups.set(clip.linkGroupId,group);}
 return doc.clips.filter(c=>c.content.kind==='video'&&!c.insertOwnSpeed).map(clip=>{
  const linked=clip.linkGroupId?(groups.get(clip.linkGroupId)??[]).filter(c=>c.id!==clip.id):[];
  const audio:SequenceClip[]=[];
  for(const other of linked){
   const a=other.content,v=clip.content;
   if(a.kind!=='audio'||a.role!=='speech'||v.kind!=='video'||other.startFrame!==clip.startFrame||other.durationFrames!==clip.durationFrames||a.assetId!==v.assetId||compareTime(a.sourceIn,v.sourceIn)!==0||compareTime(a.rate,v.rate)!==0)
    return {clip,audio:[],issue:`「${other.name}」との編集リンクを確認してください。原音と映像の使用範囲が一致する場合だけ一緒に登録できます。`};
   audio.push(other);
  }
  return {clip,audio,issue:null};
 }).sort((a,b)=>a.clip.startFrame-b.clip.startFrame||order.get(a.clip.id)!-order.get(b.clip.id)!);
}
export function registrationCommand(doc:SequenceDocument,selected:readonly string[],groupId:string){
 const options=speedRegistrationOptions(doc),ids=new Set(selected),chosen=options.filter(o=>ids.has(o.clip.id));
 if(!chosen.length||chosen.length!==ids.size||selected.length!==ids.size)throw new Error('連動させる映像を選び直してください。');
 const invalid=chosen.find(o=>o.issue);if(invalid)throw new Error(invalid.issue!);
 return {type:'register-native-speed' as const,groupId,mainClipIds:chosen.map(o=>o.clip.id),mainAudioBindings:chosen.flatMap(o=>o.audio.map(a=>({audioClipId:a.id,providerId:o.clip.id})))};
}

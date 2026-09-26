import type {SequenceClip,SequenceDocument} from '../../core/sequence/model';
import {activeTextAppearance} from '../../core/sequence/textStyle';
import type {InspectorGroupId} from './inspectorSections';

const pct=(value:number)=>`${Math.round(value*100)}%`;
/** 正規化座標（-1〜1）を言葉に。 */
function placeWord(x:number,y:number):string{
  const h=x<-0.2?'左':x>0.2?'右':'中央',v=y<-0.2?'上':y>0.2?'下':'';
  return h==='中央'&&!v?'中央':`${h}${v}`;
}
const STRENGTH:Record<string,string>={weak:'弱',mid:'中',strong:'強'};   // model.ts の 'weak'|'mid'|'strong'

/** 畳んだ群の見出しに出す 1 行（F14）。値が無ければ空文字（見出しに何も出さない）。 */
export function summarizeGroup(group:InspectorGroupId,doc:SequenceDocument,clip:SequenceClip|null):string{
  const c=clip?.content;
  switch(group){
    case 'content':
      if(!c)return '';
      if(c.kind==='telop'||c.kind==='title')return (c.data.text||'').replace(/\s+/g,' ').trim().slice(0,24);
      return clip!.name;
    case 'look':
      if(!c)return '';
      if(c.kind==='telop'){const a=activeTextAppearance(c)?c.appearance:null;return a?`${a.fontFamily.split(',')[0]!.trim()} ${a.fontSize}px · ${a.fontWeight>=700?'太':'細'}`:`スタイル ${c.data.template??1}`;}
      if(c.kind==='title')return `${c.style.fontSize}px`;
      if(c.kind==='audio')return `${c.settings.gainDb} dB${c.settings.muted?' · ミュート':''}`;
      return '';
    case 'place':{
      if(!c)return '';
      if(c.kind==='telop'){const p=c.data.position??{x:0,y:0};return `${placeWord(p.x,p.y)} · ${pct(c.data.scale??1)}`;}
      const layout=clip!.visual?.layout;
      return layout?`${placeWord(layout.position.x,layout.position.y)} · ${pct(layout.scale)}`:'';
    }
    case 'motion':{
      if(!clip)return '';
      const keys=clip.visual?.keyframes?.length??0;
      return keys?`キーフレーム ${keys}`:'なし';
    }
    case 'time':return clip?`${clip.startFrame} fr · ${clip.durationFrames} fr`:'';
    case 'project':return `速度 ${doc.speed?'連動あり':'1.0×'} · 自動音量 ${doc.ducking.enabled?STRENGTH[doc.ducking.strength]??'ON':'OFF'}`;
  }
}

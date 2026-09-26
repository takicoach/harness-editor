import { applySequenceCommand, type SequenceCommand } from '../../core/sequence/commands';
import { clipEnd, sourceTimeAt, type SequenceClip, type SequenceDocument } from '../../core/sequence/model';
import { compareTime, timeNumber } from '../../core/sequence/time';

export type TextClip = SequenceClip & { content: Extract<SequenceClip['content'], {kind:'telop'|'title'}> };
export function isTextClip(clip:SequenceClip):clip is TextClip {
  return clip.content.kind==='telop'||clip.content.kind==='title';
}
export function captionClips(document:SequenceDocument):TextClip[] {
  return document.clips.filter(isTextClip).sort((a,b)=>a.startFrame-b.startFrame||a.id.localeCompare(b.id));
}
function textClip(document:SequenceDocument,id:string):TextClip {
  const clip=document.clips.find(c=>c.id===id);
  if(!clip||!isTextClip(clip))throw new Error('対象の字幕がありません。字幕一覧を確認してください。');
  return clip;
}
export function captionTextCommand(document:SequenceDocument,id:string,text:string):SequenceCommand {
  const clip=textClip(document,id);
  return {type:'update-clip',clipId:id,patch:{name:text,content:{...clip.content,data:{...clip.content.data,text}}}};
}
const graphemes=(text:string)=>Array.from(new Intl.Segmenter('ja',{granularity:'grapheme'}).segment(text),part=>part.segment);

/** Use the source words only when they still correspond to the edited text. */
function splitText(document:SequenceDocument,clip:TextClip,frame:number,caret?:number):[string,string] {
  const text=clip.content.data.text;
  if(clip.content.kind==='title'||clip.content.data.manual===true)return [text,text];
  const parts=graphemes(text);
  if(parts.length<2)throw new Error('字幕を分割するには、本文に2文字以上必要です。');
  let index=Math.round(parts.length*(frame-clip.startFrame)/clip.durationFrames);
  if(caret!==undefined){
    if(!Number.isSafeInteger(caret)||caret<=0||caret>=text.length)throw new Error('本文の途中にカーソルを置いてください。');
    let offset=0;index=0;
    while(index<parts.length&&offset<caret)offset+=parts[index++]!.length;
  }else if(clip.anchor?.kind==='source'){
    const anchor=clip.anchor,provider=document.clips.find(c=>c.id===anchor.clipOccurrenceId);
    if(provider?.content.kind==='audio'){
      const content=provider.content;
      const words=document.transcripts.find(t=>t.assetId===content.assetId&&t.streamIndex===content.streamIndex)?.words
        .filter(w=>compareTime(w.end,anchor.sourceStart)>0&&compareTime(w.start,anchor.sourceEnd)<0)??[];
      if(words.map(w=>w.text).join('')===text){
        const at=sourceTimeAt(provider,frame,document.fps);
        index=graphemes(words.filter(w=>compareTime(w.start,at)<0).map(w=>w.text).join('')).length;
      }
    }
  }
  index=Math.max(1,Math.min(parts.length-1,index));
  return [parts.slice(0,index).join(''),parts.slice(index).join('')];
}

/** One server batch = one Undo. IDs come from the same deterministic core allocator. */
export function splitCaptionCommand(document:SequenceDocument,id:string,frame:number,caret?:number):{command:SequenceCommand;selectedId:string} {
  const clip=textClip(document,id);
  if(!Number.isSafeInteger(frame)||frame<=clip.startFrame||frame>=clipEnd(clip))throw new Error('字幕の途中へ再生位置を移動してください。');
  const [leftText,rightText]=splitText(document,clip,frame,caret);
  const split:SequenceCommand={type:'split-caption',clipId:id,frame,leftText,rightText};
  const candidate=applySequenceCommand(document,split),oldIds=new Set(document.clips.map(c=>c.id));
  const right=candidate.clips.find(c=>!oldIds.has(c.id)&&c.trackId===clip.trackId&&c.startFrame===frame&&isTextClip(c));
  if(!right)throw new Error('字幕の分割先を確認できませんでした。');
  return {command:split,selectedId:right.id};
}

export function nextCaption(document:SequenceDocument,id:string):TextClip|undefined {
  const first=textClip(document,id);
  const manual=first.content.kind==='telop'&&first.content.data.manual===true;
  return captionClips(document).find(c=>c.id!==id&&c.trackId===first.trackId&&c.startFrame>=clipEnd(first)
    &&c.content.kind===first.content.kind&&(c.content.kind!=='telop'||(c.content.data.manual===true)===manual));
}
export function mergeCaptionCommand(document:SequenceDocument,id:string):{command:SequenceCommand;selectedId:string} {
  const first=textClip(document,id),second=nextCaption(document,id);
  if(!second)throw new Error('同じトラックに結合できる次の字幕がありません。');
  const a=first.anchor,b=second.anchor;
  if((a?.kind==='source'||b?.kind==='source')&&!(a?.kind==='source'&&b?.kind==='source'&&a.clipOccurrenceId===b.clipOccurrenceId))
    throw new Error('別の映像・原音に連動する字幕です。使用箇所をまたぐ結合はまだ対応していません。');
  const command:SequenceCommand={type:'merge-captions',firstClipId:first.id,secondClipId:second.id};
  const candidate=applySequenceCommand(document,command),merged=textClip(candidate,first.id);
  if(clipEnd(merged)!==clipEnd(second))throw new Error('元の発話範囲を保って結合できませんでした。');
  return {command,selectedId:first.id};
}
export function captionTime(document:SequenceDocument,frame:number):string {
  const seconds=frame/timeNumber(document.fps);
  return `${Math.floor(seconds/60)}:${(seconds%60).toFixed(2).padStart(5,'0')}`;
}

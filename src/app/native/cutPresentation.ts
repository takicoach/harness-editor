import {clipEnd,type CutArchiveEntry,type SequenceDocument} from '../../core/sequence/model';
import {archivedWords} from '../../core/sequence/archivedCaptionWords';
export {archivedWords,type CutWord} from '../../core/sequence/archivedCaptionWords';
/** この字幕の表示区間が、保存済みカットで丸ごと消えているか。 */
export function isCaptionCut(document:SequenceDocument,clip:{startFrame:number;durationFrames:number}):boolean {
  if(clip.durationFrames<=0)return true;
  const end=clip.startFrame+clip.durationFrames;
  // `>=` (not `>`) is intentional: an archived clip whose edge exactly touches the caption's edge still fully covers it.
  return (document.cutArchive?.entries??[]).some(entry=>
    entry.clips.some(archived=>archived.startFrame<=clip.startFrame&&clipEnd(archived)>=end));
}
export function cutLabel(document:SequenceDocument,entry:CutArchiveEntry):string {
  const words=archivedWords(document,entry);if(words.length)return words.map(w=>w.text).join('');
  const texts=entry.clips.flatMap(c=>c.content.kind==='telop'||c.content.kind==='title'?[c.content.data.text]:[]);
  if(texts.length)return [...new Set(texts)].join(' / ');
  const names=entry.clips.filter(c=>c.content.kind==='video'||c.content.kind==='audio').map(c=>c.name);
  return [...new Set(names)].join(' / ')||'カットした区間';
}

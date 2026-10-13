import type {SequenceClip,SequenceDocument} from '../../core/sequence/model';
import {audioFixRoot} from '../../core/sequence/assetReferences';
import {mainTracks} from '../../core/sequence/mainTrack';
import {timeNumber} from '../../core/sequence/time';
/** 補正の系譜を原本までたどる（学習の注記とサーバ側で同じ関数を使うため core に置く）。 */
export {audioFixRoot};
export interface AudioFixCandidate {rootId:string;clip:SequenceClip}
/** 補正の対象に選べる原音（設計 §1）: 従来の対象（最初の原音）と、メインの原音トラックの素材（トラック＋原本ごとに1つ・最初の使用箇所）。適用の単位（トラック＋素材）は変えない。 */
export function audioFixCandidates(doc:SequenceDocument):AudioFixCandidate[]{
  const speech=doc.clips.filter(c=>c.content.kind==='audio'&&c.content.role==='speech'),first=speech[0];if(!first)return [];
  const audioTrackId=mainTracks(doc).audioTrackId,onMain=speech.filter(c=>c.trackId===audioTrackId).sort((a,b)=>a.startFrame-b.startFrame);
  const result:AudioFixCandidate[]=[],seen=new Set<string>();
  for(const clip of [first,...onMain]){
    if(clip.content.kind!=='audio')continue;const rootId=audioFixRoot(doc,clip.content.assetId),key=audioFixKey({rootId,clip});
    if(!seen.has(key)){seen.add(key);result.push({rootId,clip});}
  }
  return result;
}
/** 候補を区別する値（トラック＋原本）。選択欄の値に使う。 */
export const audioFixKey=(candidate:AudioFixCandidate)=>JSON.stringify([candidate.clip.trackId,candidate.rootId]);
/** 選択欄の表示: 原本の名前。同じ名前が複数ある時だけ、トラック名（トラックで分かれない時は開始時刻 m:ss）を添える。 */
export function audioFixLabels(doc:SequenceDocument,candidates:readonly AudioFixCandidate[]):string[]{
  const name=(c:AudioFixCandidate)=>doc.assets.find(asset=>asset.id===c.rootId)?.name??c.rootId;
  const track=(c:AudioFixCandidate)=>doc.tracks.find(t=>t.id===c.clip.trackId)?.name??c.clip.trackId;
  const clock=(frame:number)=>{const seconds=Math.floor(frame/timeNumber(doc.fps));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
  return candidates.map(c=>{
    const same=candidates.filter(o=>name(o)===name(c));if(same.length<2)return name(c);
    return same.every(o=>o===c||track(o)!==track(c))?`${name(c)}（${track(c)}）`:`${name(c)}（${clock(c.clip.startFrame)}から）`;
  });
}

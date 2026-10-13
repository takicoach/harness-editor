import {clipEnd,type SequenceDocument,type SequenceTrack} from './model';

/** 決まったメインのトラック。どちらも無い案件は空（最初の「メインに追加」で作る）。 */
export interface MainTracks {videoTrackId?:string;audioTrackId?:string}
/** 設計 §1: 文書に明示した main を使う。無ければ v-main / a-main（無い方は空）。話し声の役割や並び順からは推測しない。 */
export function mainTracks(doc:SequenceDocument):MainTracks{
  if(doc.main)return {videoTrackId:doc.main.videoTrackId,...(doc.main.audioTrackId?{audioTrackId:doc.main.audioTrackId}:{})};
  const has=(id:string,kind:SequenceTrack['kind'])=>doc.tracks.some(t=>t.id===id&&t.kind===kind);
  return {...(has('v-main','visual')?{videoTrackId:'v-main'}:{}),...(has('a-main','audio')?{audioTrackId:'a-main'}:{})};
}
/** メインの末尾に並べ始める位置。メインのトラックが1本も無い案件（main も v-main/a-main も無い）は、既存の映像と重ねず全体の長さの後ろから。読み込み中の枠と確定で同じ値を使う。 */
export function mainAppendStart(doc:SequenceDocument):number{
  const {videoTrackId,audioTrackId}=mainTracks(doc);
  return videoTrackId||audioTrackId?mainEnd(doc):doc.sequenceEndFrame;
}
/** メインの映像・原音トラックの最後のクリップの終わり。クリップが無ければ 0。 */
export function mainEnd(doc:SequenceDocument):number{
  const {videoTrackId,audioTrackId}=mainTracks(doc);
  return doc.clips.reduce((end,clip)=>clip.trackId===videoTrackId||clip.trackId===audioTrackId?Math.max(end,clipEnd(clip)):end,0);
}

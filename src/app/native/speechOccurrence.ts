import {clipEnd,type SequenceClip,type SequenceDocument} from '../../core/sequence/model';
import {mainTracks} from '../../core/sequence/mainTrack';
const isSpeech=(c:SequenceClip)=>c.content.kind==='audio'&&c.content.role==='speech';
/** 再生位置に追従する案件か: メインの原音トラックに別の素材（素材＋音声ストリーム）が2つ以上ある時だけ。原音1本・旧形式から移行してカットで分かれた案件は追従しない。 */
export function followsPlayhead(doc:SequenceDocument):boolean{
  const audioTrackId=mainTracks(doc).audioTrackId;if(!audioTrackId)return false;
  return new Set(doc.clips.flatMap(c=>c.trackId===audioTrackId&&isSpeech(c)&&c.content.kind==='audio'?[`${c.content.assetId}:${c.content.streamIndex}`]:[])).size>1;
}
/** 文字起こし一覧の原音（設計 §1）: 明示した使用箇所 → 選択中のクリップ（リンク含む） → 再生位置のメインの原音 → 最初のメインの原音。
 * 追従しない案件（followsPlayhead が偽）は従来どおり: 使用箇所が1つならそれ、複数なら選ぶまで決めない。
 * frame を省くと再生位置の段を飛ばす（台本の照合先は再生で動かさない）。 */
export function pickSpeechOccurrence(doc:SequenceDocument,input:{speechId:string;selected:readonly string[];selectedClip?:SequenceClip;frame?:number}):SequenceClip|undefined{
  const speech=doc.clips.filter(isSpeech);
  const explicit=speech.find(c=>c.id===input.speechId)??speech.find(c=>input.selected.includes(c.id)||!!c.linkGroupId&&c.linkGroupId===input.selectedClip?.linkGroupId);
  if(explicit)return explicit;
  const frame=input.frame;
  if(frame===undefined||!followsPlayhead(doc))return speech.length===1?speech[0]:undefined;
  const audioTrackId=mainTracks(doc).audioTrackId,ordered=[...speech].sort((a,b)=>Number(b.trackId===audioTrackId)-Number(a.trackId===audioTrackId)||a.startFrame-b.startFrame);
  return ordered.find(c=>c.startFrame<=frame&&frame<clipEnd(c))??ordered[0];
}

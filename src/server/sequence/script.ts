import { buildLiteralAlignments } from '../../core/scriptAlignment';
import { sealScriptInputPacket, createScriptProposalArtifact, scriptContentHash } from '../scriptProposalArtifacts';
import { SequenceService } from './service';
import { verifiedSequenceAssetPath } from './assets';
import { timeNumber } from '../../core/sequence/time';
import { HttpError } from '../http';
import { sequenceContentHash } from './store';

interface AlignmentRequest { sessionId:string; expectedRevision:number; occurrenceId:string; mode:'caption'|'structure' }
/** Frozen managed media and the saved v2 document are the only inputs. */
export async function collectSequenceScriptAlignment(directory:string,projectId:string,request:AlignmentRequest,sessions:SequenceService,signal?:AbortSignal) {
  const state=sessions.open(directory),doc=state.document;
  if(state.sessionId!==request.sessionId || doc.revision!==request.expectedRevision || state.dirty)throw new HttpError(409,'台本を含む現在の編集内容を保存してから照合してください');
  if(!doc.scriptDocument)throw new HttpError(400,'撮影で使った台本を入力してください');
  const occurrence=doc.clips.find(clip=>clip.id===request.occurrenceId),content=occurrence?.content;
  if(content?.kind!=='audio' || content.role!=='speech' || content.settings.muted || !doc.tracks.find(track=>track.id===occurrence?.trackId)?.enabled)
    throw new HttpError(400,'照合する有効な原音の使用箇所を選択してください');
  const asset=doc.assets.find(asset=>asset.id===content.assetId)!;
  const stream=asset.streams.find(stream=>stream.index===content.streamIndex && stream.kind==='audio')!;
  const transcript=doc.transcripts.find(item=>item.assetId===asset.id && item.streamIndex===stream.index);
  if(!transcript?.words.length)throw new HttpError(400,'この原音の文字起こしを先に用意してください');
  await verifiedSequenceAssetPath(directory,asset,signal);
  signal?.throwIfAborted();
  const words=transcript.words.map((word,index)=>({index,text:word.text,startMs:timeNumber(word.start)*1000,endMs:timeNumber(word.end)*1000}));
  const packet=sealScriptInputPacket({schemaVersion:1,packetHash:'0'.repeat(64),projectId,editRevision:`native:${doc.revision}:${sequenceContentHash(doc)}`,
    source:{id:`native:${scriptContentHash([asset.id,stream.index,occurrence!.id])}`,revision:asset.fingerprint,durationMs:timeNumber(stream.duration)*1000},
    script:doc.scriptDocument,transcript:{revision:scriptContentHash(transcript),words}});
  const skillId=request.mode==='caption'?'subtitle-orthography':'script-structure';
  const artifact=createScriptProposalArtifact(packet,buildLiteralAlignments(packet,{skillId,skillVersion:'1',provider:'deterministic',model:'literal-v1',
    configHash:scriptContentHash({schemaVersion:1,skillId,normalization:'whitespace-only',matcher:'literal-word-boundaries'})}));
  const latest=sessions.open(directory);
  if(latest.sessionId!==state.sessionId || latest.document.revision!==doc.revision || latest.dirty || latest.savedContentHash!==state.savedContentHash)
    throw new HttpError(409,'照合中に編集内容が変わりました。現在の内容でもう一度照合してください');
  return artifact;
}

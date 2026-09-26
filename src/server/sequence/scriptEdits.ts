import { existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSequenceScriptAlignment } from './script';
import { nativeScriptEditing,sequenceScriptEditCommand } from '../../core/sequence/scriptEdits';
import { parseScriptEditArtifact,sealScriptEditInput } from '../scriptEditArtifacts';
import type { ScriptEditArtifact } from '../../core/scriptEditArtifact';
import type { ScriptEditModification } from '../../core/scriptEditModification';
import type { NativeSavedScriptEditReview } from '../editorAgentContext';
import { applySequenceCommand } from '../../core/sequence/commands';
import { parseSequence,serializeSequence } from '../../core/sequence/validate';
import type { SequenceDocument } from '../../core/sequence/model';
import { sequenceContentHash,SequenceStore } from './store';
import { scriptContentHash } from '../scriptProposalArtifacts';
import { timeNumber } from '../../core/sequence/time';
import type { SequenceService } from './service';
import { HttpError } from '../http';

interface InputRequest {sessionId:string;expectedRevision:number;occurrenceId:string;mode:'caption'|'structure'}
function inputFile(directory:string,inputHash:string,create=false):string {
  if(!/^[a-f0-9]{64}$/.test(inputHash))throw new Error('台本案の入力IDが不正です');
  for(const part of ['.harness','script-inputs']) {
    directory=join(directory,part);if(create)mkdirSync(directory,{recursive:true});
    if(!existsSync(directory))throw new HttpError(409,'台本案を作る前の編集記録がありません。入力を作り直してください');
    const info=lstatSync(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('台本案の記録先が不正です');
  }
  return join(directory,`${inputHash}.json`);
}
export async function collectNativeScriptEditInput(directory:string,projectId:string,request:InputRequest,sessions:SequenceService,signal?:AbortSignal) {
  const alignment=await collectSequenceScriptAlignment(directory,projectId,request,sessions,signal),state=sessions.open(directory);
  if(state.sessionId!==request.sessionId||state.document.revision!==request.expectedRevision||state.dirty)throw new HttpError(409,'台本案の入力を作る間に編集内容が変わりました');
  const document=state.document,input=sealScriptEditInput({schemaVersion:1,inputHash:'0'.repeat(64),alignment,...nativeScriptEditing(document,sequenceContentHash(document),request.occurrenceId)});
  const file=inputFile(directory,input.inputHash,true),bytes=JSON.stringify({version:1,inputHash:input.inputHash,document:JSON.parse(serializeSequence(document))});
  try{writeFileSync(file,bytes,{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(lstatSync(file).isSymbolicLink()||readFileSync(file,'utf8')!==bytes)throw new Error('台本案の入力記録が変更されています');}
  return input;
}
export function readNativeScriptInputDocument(directory:string,value:ScriptEditArtifact):SequenceDocument {
  const artifact=parseScriptEditArtifact(value),binding=artifact.input.native;
  if(!binding)throw new Error('NATIVE_SCRIPT_BINDING_REQUIRED');
  const file=inputFile(directory,artifact.input.inputHash),info=lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024*1024)throw new Error('台本案の入力記録が不正です');
  const saved=JSON.parse(readFileSync(file,'utf8'));
  if(saved.version!==1||saved.inputHash!==artifact.input.inputHash)throw new Error('台本案の入力IDが一致しません');
  const document=parseSequence(JSON.stringify(saved.document));
  if(document.id!==binding.documentId||document.revision!==binding.revision||sequenceContentHash(document)!==binding.contentHash)throw new Error('台本案を作った時の編集内容が変更されています');
  return document;
}
export function previewNativeScriptEdit(directory:string,projectId:string,value:unknown,modification?:ScriptEditModification) {
  const artifact=parseScriptEditArtifact(value);
  if(artifact.input.alignment.packet.projectId!==projectId)throw new HttpError(409,'別の案件に対する台本案です');
  const before=readNativeScriptInputDocument(directory,artifact),command=sequenceScriptEditCommand(before,sequenceContentHash(before),artifact,modification);
  return {artifact,before,after:applySequenceCommand(before,command),command};
}
export function assertNativeScriptEditCurrent(directory:string,projectId:string,value:unknown,current:SequenceDocument,modification?:ScriptEditModification) {
  const preview=previewNativeScriptEdit(directory,projectId,value,modification);
  if(current.revision!==preview.before.revision||sequenceContentHash(current)!==sequenceContentHash(preview.before))throw new HttpError(409,'変更案を作った後に編集内容が変わっています。現在の内容で作り直してください');
  return preview;
}

/** Compare the complete v2 document, never synthesize legacy cut state or an execution receipt. */
export function inspectNativeSavedScriptEdit(directory:string,projectId:string,value:ScriptEditArtifact,modification?:ScriptEditModification):NativeSavedScriptEditReview {
  const preview=previewNativeScriptEdit(directory,projectId,value,modification),saved=new SequenceStore(directory).load();
  if(!saved)throw new Error('NATIVE_DOCUMENT_REQUIRED: 保存した編集内容がありません');
  const inputStateHash=sequenceContentHash(preview.before),proposalStateHash=sequenceContentHash(preview.after),stateHash=saved.contentHash;
  return {documentFormat:'sequence-v2',kind:preview.artifact.proposal.kind,...(modification?{modified:true}:{}),
    savedState:stateHash===proposalStateHash?'proposal':stateHash===inputStateHash?'input':'diverged',stateHash,inputStateHash,proposalStateHash,
    fingerprintHash:scriptContentHash({revision:saved.savedRevision,contentHash:stateHash}),presenceHash:stateHash,
    current:{fps:timeNumber(saved.document.fps),totalFrames:saved.document.sequenceEndFrame,scriptDocument:saved.document.scriptDocument??null,
      clips:saved.document.clips.map(clip=>({id:clip.id,name:clip.name,kind:clip.content.kind,startFrame:clip.startFrame,endFrame:clip.startFrame+clip.durationFrames,
        ...(clip.content.kind==='telop'?{text:clip.content.data.text}:{})}))}};
}

import {createHash,randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {loadProject} from '../../core/project';
import {readProjectFiles} from '../loadProjectFiles';
import {SequenceError} from '../../core/sequence/errors';
import {migrateLegacySequence,type LegacyAssetBindings} from '../../core/sequence/migrateLegacy';
import {migrateLegacyWithCutHistory} from '../../core/sequence/migrateLegacyWithCutHistory';
import {legacyPreviewReferences} from '../../core/sequence/legacyPreview';
import {assertLegacyCutHistoryEligible,buildLegacyCutHistoryCommand,type AdoptLegacyCutHistoryCommand} from '../../core/sequence/legacyCutBackfill';
import {applySequenceCommand} from '../../core/sequence/commands';
import {resolveCutBoundary} from '../../core/sequence/cutArchive';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {legacyInputFingerprint} from './migration';
import {openSequenceAsset,registeredSequenceAssets,onlyAttachedPicturesDiffer,type SequenceAssetLease} from './assets';
import {SequenceService,sequenceService} from './service';
import {sequenceContentHash} from './store';
import {probeSequenceAssetSource} from './media';
import {resolvePublicAsset} from '../projectRoot';

interface Owner {sessionId:string;expectedRevision:number}
interface Adoption extends Owner {executionId:string;planId:string;planDigest:string}
interface Plan {root:string;owner:Owner;documentId:string;digest:string;createdAt:number;beforeHash:string;command:AdoptLegacyCutHistoryCommand;assets:SequenceAsset[];executionId?:string}
function fail(message:string):never{throw new SequenceError('REVISION_CONFLICT',message);}

/** Resolve old names only through this saved document's immutable asset mapping. */
async function sourceBindings(root:string,document:SequenceDocument,project:ReturnType<typeof loadProject>,signal?:AbortSignal):Promise<{bindings:LegacyAssetBindings;assets:SequenceAsset[]}>{
 const refs=legacyPreviewReferences(project),used=new Map<string,SequenceAsset>();
 const find=(id:string|undefined,kind:SequenceAsset['kind'])=>{
  const asset=document.assets.find(a=>a.id===id);
  if(!asset||asset.kind!==kind)fail('旧カットに必要な保存素材・描画部品の対応がありません。素材を確認してください');
  used.set(asset.id,asset);return asset.id;
 };
 if(document.rendering?.staticFiles?.[refs.main]&&document.rendering.staticFiles[refs.main]!==document.legacy!.primaryAssetId)fail('移行元の主映像と保存素材の対応が一致しません');
 const b:LegacyAssetBindings={main:find(document.legacy!.primaryAssetId,'media'),images:{},videoInserts:{},bgm:{},se:{}};
 if(refs.telop)b.telopComponent=find(document.rendering?.telopComponentAssetId,'component');
 if(refs.image)b.imageComponent=find(document.rendering?.imageComponentAssetId,'component');
 for(const [items,prefix,bindings,kind] of [[refs.images,'images/',b.images,'image'],[refs.videoInserts,'',b.videoInserts,'media'],[refs.bgm,'BGM/',b.bgm,'media'],[refs.se,'se/',b.se,'media']] as const)
  for(const item of items){
   const name=prefix+item.file;let assetId=document.rendering?.staticFiles?.[name];
   if(!assetId){
    // Old audio-only projects did not create rendering.staticFiles. Recover
    // a binding by full content/stream equality with an already saved asset;
    // no filename guess, asset import, or replacement of the live document.
    const inspected=await probeSequenceAssetSource(resolvePublicAsset(root,name),name,item.file,signal);
    const matches=document.assets.filter(a=>a.kind===kind&&a.kind===inspected.asset.kind&&a.fingerprint===inspected.asset.fingerprint&&(isDeepStrictEqual(a.streams,inspected.asset.streams)||onlyAttachedPicturesDiffer(a.streams,inspected.asset.streams,inspected.attachedPictureIndexes)));
    if(matches.length!==1)fail('旧素材と一致する保存済み素材を特定できません。元の素材を確認してください');
    assetId=matches[0]!.id;
   }
   bindings[item.id]=find(assetId,kind);
  }
 // Component runtime staticFile dependencies use the saved name table as well.
 for(const assetId of Object.values(document.rendering?.staticFiles??{})){
  const asset=document.assets.find(a=>a.id===assetId);if(!asset)fail('保存された描画素材の対応がありません');used.set(asset.id,asset);
 }
 return {bindings:b,assets:[...used.values()]};
}
async function leaseAssets(root:string,assets:SequenceAsset[],signal?:AbortSignal):Promise<SequenceAssetLease[]>{
 const registry=await registeredSequenceAssets(root),leases:SequenceAssetLease[]=[];
 try{
  for(const asset of assets){
   signal?.throwIfAborted();
   if(asset.kind!=='component'){
    const record=registry.find(a=>a.id===asset.id);
    if(!record||record.file!==asset.file||record.kind!==asset.kind||record.fingerprint!==asset.fingerprint||!isDeepStrictEqual(record.streams,asset.streams))fail('保存素材と登録台帳が一致しません');
   }
   leases.push(await openSequenceAsset(root,asset,signal));
  }
  return leases;
 }catch(error){await Promise.allSettled(leases.map(l=>l.close()));throw error;}
}

/** Small session-bound plans; no source execution, copying, writer-authority bypass or disk replacement. */
export class LegacyCutBackfills {
 private plans=new Map<string,Plan>();
 constructor(private sessions:SequenceService=sequenceService){}
 async prepare(directory:string,owner:Owner,signal?:AbortSignal){
  const root=realpathSync(directory),state=this.sessions.open(root),doc=state.document;
  if(state.sessionId!==owner.sessionId||doc.revision!==owner.expectedRevision)fail('編集内容が変わりました。旧カットを確認し直してください');
  assertLegacyCutHistoryEligible(doc,doc.legacy?.sourceFingerprint??'');
  const fingerprint=await legacyInputFingerprint(root);
  if(fingerprint!==doc.legacy!.sourceFingerprint)fail('移行時の旧編集データと現在の内容が一致しません');
  const project=loadProject(readProjectFiles(root)),{bindings,assets}=await sourceBindings(root,doc,project,signal),leases=await leaseAssets(root,assets,signal);
  try{
   const input={id:doc.id,name:doc.name,project,assets:doc.assets,bindings,sourceFingerprint:fingerprint};
   const baseline=migrateLegacySequence(input).document,reconstructed=migrateLegacyWithCutHistory(input).document;
   const command=buildLegacyCutHistoryCommand(doc,baseline,reconstructed);
   // Dry-run the exact server-owned payload, including current asset/track/archive validation.
   applySequenceCommand(doc,command);
   const preview=doc;
   if(await legacyInputFingerprint(root)!==fingerprint)fail('準備中に旧編集データが変更されました');
   for(const lease of leases)await lease.verify();
   signal?.throwIfAborted();
   const current=this.sessions.open(root),beforeHash=sequenceContentHash(doc);
   if(current.sessionId!==owner.sessionId||current.document.revision!==owner.expectedRevision||sequenceContentHash(current.document)!==beforeHash)fail('準備中に編集内容が変わりました');
   const planId=randomUUID(),digest=createHash('sha256').update(JSON.stringify([doc.id,owner,beforeHash,command])).digest('hex'),createdAt=Date.now();
   for(const [id,plan]of this.plans)if(createdAt-plan.createdAt>15*60_000)this.plans.delete(id);
   while(this.plans.size>=16)this.plans.delete(this.plans.keys().next().value!);
   this.plans.set(planId,{root,owner:{...owner},documentId:doc.id,digest,createdAt,beforeHash,command,assets:structuredClone(assets)});
   return {planId,planDigest:digest,documentId:doc.id,revision:doc.revision,sourceFingerprint:fingerprint,entries:command.entries.map(e=>({id:e.id,durationFrames:e.durationFrames,originalStart:e.legacyRecovery!.originalStart,originalEnd:e.legacyRecovery!.originalEnd,...resolveCutBoundary(preview,e)}))};
  }finally{await Promise.allSettled(leases.map(l=>l.close()));}
 }
 async adopt(directory:string,request:Adoption,signal?:AbortSignal){
  const root=realpathSync(directory),plan=this.plans.get(request.planId);
  if(!plan||plan.root!==root||plan.digest!==request.planDigest||plan.owner.sessionId!==request.sessionId||plan.owner.expectedRevision!==request.expectedRevision||Date.now()-plan.createdAt>15*60_000)fail('旧カットの確認が期限切れ、または別の編集状態です。確認し直してください');
  if(plan.executionId&&plan.executionId!==request.executionId)fail('この確認結果は既に別の操作で反映されています');
  const edit={sessionId:request.sessionId,expectedRevision:request.expectedRevision,executionId:request.executionId,command:plan.command};
  signal?.throwIfAborted();
  if(plan.executionId)return this.sessions.execute(root,edit);
  const state=this.sessions.open(root);
  if(state.sessionId!==request.sessionId||state.document.id!==plan.documentId||state.document.revision!==request.expectedRevision||sequenceContentHash(state.document)!==plan.beforeHash)fail('編集内容が変わりました。旧カットを確認し直してください');
  const leases=await leaseAssets(root,plan.assets,signal);
  try{
   if(await legacyInputFingerprint(root)!==plan.command.sourceFingerprint)fail('確認後に旧編集データが変更されました');
   for(const lease of leases)await lease.verify();
   signal?.throwIfAborted();
   const result=this.sessions.execute(root,edit);plan.executionId=request.executionId;return result;
  }finally{await Promise.allSettled(leases.map(l=>l.close()));}
 }
}
export const legacyCutBackfills=new LegacyCutBackfills();

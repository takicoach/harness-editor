import {createHash,randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {previewSilenceCuts} from '../../core/sequence/commands';
import {silenceSources,planSilenceRanges,type SourceEnvelope} from '../../core/sequence/silenceCutPlan';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {silenceSettings,type SilenceOwner,type SilencePlan,type SilenceRange,type SilenceStatus} from '../../shared/silenceCut';
import {acquireSilenceEnvelope} from './silenceEnvelope';
import {SequenceService} from './service';
import {sequenceContentHash} from './store';
import {openSequenceAsset} from './assets';
import {HttpError} from '../http';
import type {EditRequest} from '../../core/sequence/session';

interface Analysis {root:string;owner:SilenceOwner;trackIds:string[];doc:SequenceDocument;status:SilenceStatus;controller:AbortController;sources:SourceEnvelope[];release:Array<()=>void>;created:number}
interface PlanRecord {root:string;owner:SilenceOwner;beforeHash:string;doc:SequenceDocument;assets:SequenceAsset[];public:SilencePlan;controller:AbortController;preview?:SequenceDocument;applied?:{executionId:string;request:string};created:number}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
const input=<T>(run:()=>T):T=>{try{return run();}catch(e){throw new HttpError(400,errorText(e));}};

export class SilenceAnalyses {
  private analyses=new Map<string,Analysis>();
  private plans=new Map<string,PlanRecord>();
  // Lightweight receipts live with their editing session, independently of disposable analyses/previews.
  private receipts=new Map<string,{root:string;request:string;edit:EditRequest}>();
  constructor(private sessions:SequenceService,private acquire=acquireSilenceEnvelope){}
  private expireLater(){setTimeout(()=>this.trim(),15*60_000+100).unref();}
  private current(root:string,owner:SilenceOwner){
    const state=this.sessions.inspect(root,owner.sessionId);
    if(state.externalChange||state.document.revision!==owner.expectedRevision)throw new HttpError(409,'編集内容が変わりました。無音候補を再解析してください');return state;
  }
  private trim(){
    for(const [id,a] of this.analyses)if(Date.now()-a.created>15*60_000){a.controller.abort();a.release.forEach(f=>f());this.analyses.delete(id);}
    for(const [id,p] of this.plans)if(Date.now()-p.created>15*60_000){p.controller.abort();this.plans.delete(id);}
    while(this.plans.size>=12){const [id,p]=this.plans.entries().next().value!;p.controller.abort();this.plans.delete(id);}
  }
  start(root:string,owner:SilenceOwner,trackIds:string[]):SilenceStatus{
    root=realpathSync(root);this.trim();
    if([...this.analyses.values()].filter(a=>a.status.phase==='analyzing').length>=2)throw new HttpError(429,'ほかの音声解析の完了を待ってください');
    // Only completed records can be retired for capacity. Active readers keep their leases.
    while(this.analyses.size>=8){const old=[...this.analyses].find(([,a])=>a.status.phase!=='analyzing');if(!old)throw new HttpError(429,'音声解析の上限に達しました');old[1].release.forEach(f=>f());this.analyses.delete(old[0]);}
    const doc=this.current(root,owner).document;
    for(const [id,r] of this.receipts)if(r.root===root&&r.edit.sessionId!==owner.sessionId)this.receipts.delete(id);
    input(()=>silenceSources(doc,trackIds));
    const status:SilenceStatus={analysisId:randomUUID(),phase:'analyzing',percent:0};
    const a:Analysis={root,owner:{...owner},trackIds:[...trackIds],doc,status,controller:new AbortController(),sources:[],release:[],created:Date.now()};
    this.analyses.set(status.analysisId,a);this.expireLater();void this.run(a);return {...status};
  }
  private async run(a:Analysis){
    try{
      const selected=silenceSources(a.doc,a.trackIds),keys=new Set<string>();
      for(const clip of selected){if(clip.content.kind==='audio')keys.add(`${clip.content.assetId}:${clip.content.streamIndex}`);}
      let bytes=0,index=0;
      for(const key of keys){
        const clip=selected.find(c=>c.content.kind==='audio'&&`${c.content.assetId}:${c.content.streamIndex}`===key)!;
        if(clip.content.kind!=='audio')throw new Error('原音の参照が不正です');
        const assetId=clip.content.assetId,streamIndex=clip.content.streamIndex,asset=a.doc.assets.find(x=>x.id===assetId)!;
        const stream=asset.streams.find(s=>s.index===streamIndex)!;
        if(bytes+Math.ceil(stream.duration.num/stream.duration.den*100)*4>32*1024*1024)throw new Error('解析する音声が多すぎます。対象トラックを減らしてください');
        const value=await this.acquire(a.root,asset,streamIndex,a.controller.signal,p=>{a.status.percent=(index+p/100)/keys.size*100;});
        a.release.push(value.release);a.controller.signal.throwIfAborted();bytes+=value.envelope.rms.byteLength;
        if(bytes>32*1024*1024)throw new Error('解析する音声が多すぎます。対象トラックを減らしてください');
        a.sources.push({assetId,streamIndex,envelope:value.envelope});index++;
      }
      a.controller.signal.throwIfAborted();a.status.phase='completed';a.status.percent=100;
    }catch(e){a.status.phase=a.controller.signal.aborted?'cancelled':'failed';a.status.error=errorText(e);a.release.forEach(f=>f());a.release=[];a.sources=[];}
  }
  private analysis(root:string,analysisId:string,sessionId:string){
    const a=this.analyses.get(analysisId);if(!a||a.root!==realpathSync(root)||a.owner.sessionId!==sessionId)throw new HttpError(404,'無音解析が見つかりません。もう一度解析してください');return a;
  }
  status(root:string,id:string,sessionId:string){return {...this.analysis(root,id,sessionId).status};}
  cancel(root:string,id:string,sessionId:string){const a=this.analysis(root,id,sessionId);a.controller.abort();a.release.forEach(f=>f());a.release=[];a.sources=[];a.status.phase='cancelled';for(const p of this.plans.values())if(p.public.analysisId===id)p.controller.abort();return {...a.status};}
  plan(root:string,owner:SilenceOwner,analysisId:string,settings:unknown,scope?:SilenceRange):SilencePlan{
    const a=this.analysis(root,analysisId,owner.sessionId);if(a.status.phase!=='completed')throw new HttpError(409,'音声解析の完了を待ってください');
    const doc=this.current(a.root,owner).document;
    if(doc.revision!==a.owner.expectedRevision)throw new HttpError(409,'編集内容が変わりました。再解析してください');
    const s=input(()=>silenceSettings(settings)),ranges=input(()=>planSilenceRanges(doc,a.trackIds,a.sources,s,scope)),removedFrames=ranges.reduce((n,v)=>n+v.endFrame-v.startFrame,0);
    // Retire previous checking plans for this analysis; rapid slider input cannot queue expensive dry-runs.
    for(const [id,p] of this.plans)if(p.public.analysisId===analysisId&&!p.applied){p.controller.abort();this.plans.delete(id);}
    this.trim();const beforeHash=sequenceContentHash(doc),planId=randomUUID();
    const result:SilencePlan={planId,planDigest:digest([a.root,owner,beforeHash,s,ranges]),analysisId,sessionId:owner.sessionId,revision:doc.revision,ranges,removedFrames,resultFrames:doc.sequenceEndFrame-removedFrames,settings:s,phase:'checking'};
    const assetIds=new Set(a.sources.map(source=>source.assetId)),p:PlanRecord={root:a.root,owner:{...owner},beforeHash,doc,assets:doc.assets.filter(x=>assetIds.has(x.id)),public:result,controller:new AbortController(),created:Date.now()};
    this.plans.set(planId,p);this.expireLater();void this.check(p);return structuredClone(result);
  }
  private async check(p:PlanRecord){
    try{await yieldLoop();p.preview=await previewSilenceCuts(p.doc,p.public.ranges,async()=>{p.controller.signal.throwIfAborted();await yieldLoop();});p.controller.signal.throwIfAborted();p.public.resultFrames=p.preview.sequenceEndFrame;p.public.phase='ready';}
    catch(e){p.public.phase='failed';p.public.error=errorText(e);p.preview=undefined;}
  }
  private record(root:string,id:string,sessionId:string){const p=this.plans.get(id);if(!p||p.root!==realpathSync(root)||p.owner.sessionId!==sessionId)throw new HttpError(404,'無音カットの計画がありません。再解析してください');return p;}
  planStatus(root:string,id:string,sessionId:string){return structuredClone(this.record(root,id,sessionId).public);}
  preview(root:string,id:string,owner:SilenceOwner){const p=this.record(root,id,owner.sessionId);this.current(p.root,owner);if(p.owner.expectedRevision!==owner.expectedRevision||p.public.phase!=='ready'||p.controller.signal.aborted||!p.preview)throw new HttpError(409,'試聴する計画を再確認してください');return structuredClone({...p.preview,id:`${p.doc.id}:silence:${id}`});}
  async apply(root:string,owner:SilenceOwner,id:string,planDigest:string,executionId:string,signal:AbortSignal){
    const request=JSON.stringify([owner,id,planDigest,executionId]),receipt=this.receipts.get(id);
    if(receipt){if(receipt.root!==realpathSync(root)||receipt.request!==request)throw new HttpError(409,'この無音カットの確認情報が一致しません');return this.sessions.execute(receipt.root,receipt.edit);}
    const p=this.record(root,id,owner.sessionId);
    if(p.public.planDigest!==planDigest||p.owner.expectedRevision!==owner.expectedRevision)throw new HttpError(409,'計画の確認情報が一致しません');
    const edit={...owner,executionId,command:{type:'apply-silence-cut' as const,ranges:p.public.ranges}};
    if(p.applied){if(p.applied.request!==request)throw new HttpError(409,'この無音カットは既に適用済みです');return this.sessions.execute(p.root,edit);}
    if(p.public.phase!=='ready'||p.controller.signal.aborted)throw new HttpError(409,'候補の確認が完了していません');
    if(sequenceContentHash(this.current(p.root,owner).document)!==p.beforeHash)throw new HttpError(409,'編集内容が変わりました');
    const leases=[];
    try{
      for(const asset of p.assets)leases.push(await openSequenceAsset(p.root,asset,signal));
      await Promise.all(leases.map(l=>l.verify()));signal.throwIfAborted();
      // All asynchronous work finishes before the final revision check and synchronous commit.
      const committed=(p as PlanRecord).applied;
      if(committed){if(committed.request!==request)throw new HttpError(409,'この無音カットは既に適用済みです');return this.sessions.execute(p.root,edit);}
      if(p.controller.signal.aborted)throw new HttpError(409,'無音カットがキャンセルされました');
      this.current(p.root,owner);
      const result=this.sessions.execute(p.root,edit);p.applied={executionId,request};this.receipts.set(id,{root:p.root,request,edit});return result;
    }finally{await Promise.allSettled(leases.map(l=>l.close()));}
  }
}

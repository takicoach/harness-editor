import type {IncomingMessage,ServerResponse} from 'node:http';
import {sendJson,HttpError} from '../http';
import {readJsonBody} from '../readBody';
import {SequenceService} from './service';
import {SilenceAnalyses} from './silenceAnalyses';
import type {SilenceRange} from '../../shared/silenceCut';
const managers=new WeakMap<SequenceService,SilenceAnalyses>();
function identifier(v:unknown):string{if(typeof v!=='string'||!v||v.length>256)throw new HttpError(400,'無音カットのIDが不正です');return v;}
function revision(v:unknown):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new HttpError(400,'編集版が不正です');return v;}
export async function handleSilenceCutApi(req:IncomingMessage,res:ServerResponse,url:URL,root:string,sessions:SequenceService,signal:AbortSignal):Promise<boolean>{
  const route=url.pathname.slice('/api/sequence'.length);if(!route.startsWith('/silence/'))return false;
  const reads=['/silence/status','/silence/plan-status'],writes=['/silence/analyze','/silence/plan','/silence/cancel','/silence/preview','/silence/apply'];
  if(!reads.includes(route)&&!writes.includes(route))throw new HttpError(404,'無音カットの操作がありません');
  if((req.method??'GET')!==(reads.includes(route)?'GET':'POST'))throw new HttpError(405,'操作のメソッドが不正です');
  let m=managers.get(sessions);if(!m){m=new SilenceAnalyses(sessions);managers.set(sessions,m);}
  if(reads.includes(route)){
    const session=identifier(url.searchParams.get('sessionId'));
    sendJson(res,200,route.endsWith('/status')?m.status(root,identifier(url.searchParams.get('analysisId')),session):m.planStatus(root,identifier(url.searchParams.get('planId')),session));return true;
  }
  const raw=await readJsonBody(req,64*1024);if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HttpError(400,'無音カットの要求が不正です');
  const b=raw as Record<string,unknown>,sessionId=identifier(b.sessionId);
  if(route==='/silence/cancel'){sendJson(res,200,m.cancel(root,identifier(b.analysisId),sessionId));return true;}
  const owner={sessionId,expectedRevision:revision(b.expectedRevision)};
  if(route==='/silence/analyze'){
    if(!Array.isArray(b.trackIds))throw new HttpError(400,'対象音声を選んでください');
    sendJson(res,200,m.start(root,owner,b.trackIds.map(identifier)));
  }else if(route==='/silence/plan'){
    let scope:SilenceRange|undefined;if(b.scope!==undefined){if(!b.scope||typeof b.scope!=='object')throw new HttpError(400,'対象範囲が不正です');const v=b.scope as Record<string,unknown>;scope={startFrame:revision(v.startFrame),endFrame:revision(v.endFrame)};}
    sendJson(res,200,m.plan(root,owner,identifier(b.analysisId),b.settings,scope));
  }else if(route==='/silence/preview')sendJson(res,200,m.preview(root,identifier(b.planId),owner));
  else sendJson(res,200,await m.apply(root,owner,identifier(b.planId),identifier(b.planDigest),identifier(b.executionId),signal));
  return true;
}

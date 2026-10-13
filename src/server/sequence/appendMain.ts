import {randomUUID} from 'node:crypto';
import type {SequenceAsset} from '../../core/sequence/model';
import type {SequenceCommand} from '../../core/sequence/commands';
import {buildAppendToMain} from '../../core/sequence/mainAppend';
import {HttpError} from '../http';
import {registeredSequenceAssets,verifiedSequenceAssetPath} from './assets';
import type {SequenceService,SequenceSessionState} from './service';

type AppendResult=ReturnType<typeof executeAppendToMain>;
/** 同じ実行 ID の再送を再実行しない（版は実行時点の最新で組み立てるので、session の実行記録とは照合できない）。 */
const receipts=new Map<string,string>();
/**
 * 処理中の追加（実行 ID ごと）。同じ内容の要求（応答が届かなかった時の再送）は同じ処理の結果を受け取り、違う内容は 409 で断る。
 * 処理は要求の接続とは別の中止を持つ: 各要求が切れても自分の待ちをやめるだけで、待つ要求が1件も残らなくなった時だけ処理を中止する
 * （応答の届かない追加を残さない）。失敗・中止で終わった処理は外し、同じ実行 ID の再送は新しく実行する。
 */
interface Running {key:string;work:Promise<AppendResult>;controller:AbortController;waiting:number;settled:boolean}
const running=new Map<string,Running>();
/** 素材行の「メインの末尾に追加」（設計 §1 ①②）。サーバが実行時点の文書で組み立てる（素材の登録は HTTP の /command では受けないため）。 */
export async function appendAssetsToMain(directory:string,sessions:SequenceService,request:{sessionId:string;executionId:string;assetIds:string[]},signal?:AbortSignal){
  signal?.throwIfAborted();
  const key=JSON.stringify([directory,request.sessionId,request.assetIds]),previous=receipts.get(request.executionId);
  if(previous!==undefined){
    if(previous!==key)throw new HttpError(409,'同じ実行IDに異なる追加があります');
    const state=sessions.inspect(directory,request.sessionId);
    return {...state,executionId:request.executionId,appliedRevision:state.document.revision,changed:false,replayed:true};
  }
  // 待つ要求が全部去った処理は実行しない（下の throwIfAborted）ので、加わらずに新しく実行する。
  let run=running.get(request.executionId);if(run?.controller.signal.aborted)run=undefined;
  if(run&&run.key!==key)throw new HttpError(409,'同じ実行IDに異なる追加があります');
  if(!run){
    const controller=new AbortController(),entry:Running={key,controller,waiting:0,settled:false,work:append(directory,sessions,request,key,controller.signal)};
    const done=()=>{entry.settled=true;if(running.get(request.executionId)===entry)running.delete(request.executionId);};
    void entry.work.then(done,done);running.set(request.executionId,entry);run=entry;
  }
  return wait(run,signal);
}
async function append(directory:string,sessions:SequenceService,request:{sessionId:string;executionId:string;assetIds:string[]},key:string,signal:AbortSignal):Promise<AppendResult>{
  const current=sessions.open(directory),registry=await registeredSequenceAssets(directory),assets:SequenceAsset[]=[];
  for(const assetId of request.assetIds){
    const asset=current.document.assets.find(item=>item.id===assetId)??registry.find(item=>item.id===assetId);
    if(!asset)throw new HttpError(404,'取り込み済みの素材がありません');assets.push(asset);
  }
  for(const asset of new Set(assets))await verifiedSequenceAssetPath(directory,asset,signal);
  // 素材の確認（全体のハッシュ）を待つ間に版が進んでもよいよう、組み立ては確認の後の最新の文書で行う（ここから実行まで同期）。
  // 待つ要求が全部切れた処理は実行しない（応答の届かない追加を残さず、再送が新しく実行する）。
  signal.throwIfAborted();
  const result=executeAppendToMain(directory,sessions,sessions.inspect(directory,request.sessionId),request,assets,randomUUID);
  receipts.set(request.executionId,key);while(receipts.size>256)receipts.delete(receipts.keys().next().value!);
  return result;
}
/** 処理の結果を待つ。自分の接続が切れたら自分の待ちだけをやめ、最後の1件が去った時に処理を中止する。 */
function wait(run:Running,signal?:AbortSignal):Promise<AppendResult>{
  run.waiting++;
  return new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(settle:()=>void)=>{
      if(finished)return;finished=true;signal?.removeEventListener('abort',abort);
      if(!--run.waiting&&!run.settled)run.controller.abort(new Error('追加を待つ要求がありません'));settle();
    };
    const abort=()=>finish(()=>reject(signal!.reason??new Error('追加を中止しました')));
    signal?.addEventListener('abort',abort,{once:true});
    run.work.then(result=>finish(()=>resolve(result)),error=>finish(()=>reject(error)));
  });
}
/**
 * 末尾への配置を `latest`（呼び出し側が素材の確認の後に取った最新の文書）で組み立てて実行する。素材行の追加と取り込みの束の確定で共有。
 * 版は latest の版で照合する。呼び出し側は latest の取得からここまでを同期で続ける（間に await を挟まない）。
 * `beforeExecute` は組み立てに成功した後・実行の直前に呼ぶ（束の確定の印を先に書くため。投げれば実行しない）。
 * `registerOnly` は並べずに素材の一覧へ登録だけする素材（取り込みの束の映像の無い素材）。同じ1回の編集に入れる（Undo 1回で全部戻る）。
 */
export function executeAppendToMain(directory:string,sessions:SequenceService,latest:SequenceSessionState,request:{sessionId:string;executionId:string},assets:readonly SequenceAsset[],newId:()=>string,beforeExecute?:()=>void,registerOnly:readonly SequenceAsset[]=[]){
  const plan=buildAppendToMain(latest.document,assets,newId);
  if('error' in plan)throw new HttpError(plan.code==='SPEED_REGISTERED'?409:422,plan.error,{reason:plan.code});
  const extra=[...new Map(registerOnly.filter(asset=>!latest.document.assets.some(item=>item.id===asset.id)&&!assets.some(item=>item.id===asset.id)).map(asset=>[asset.id,asset])).values()];
  const command:SequenceCommand=extra.length?{type:'batch',commands:[...plan.command.commands,{type:'register-assets',assets:extra.map(asset=>structuredClone(asset))}]}:plan.command;
  beforeExecute?.();
  return sessions.execute(directory,{sessionId:request.sessionId,expectedRevision:latest.document.revision,executionId:request.executionId,command});
}

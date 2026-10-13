import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import type {NativeExportPreflight} from '../../shared/nativeExport';
import {openSequenceAsset,type SequenceAssetLease} from './assets';
import {readSequenceComponent} from './components';
import {isSequenceReferenceFile} from './references';
import {UNRESPONSIVE_READ_MS,UnresponsiveFileError,unresponsiveReadMessage} from './fsWatch';

/** 試験専用: 応答しない読みを見限る長さ（試験で縮める）。根拠は fsWatch.ts の UNRESPONSIVE_READ_MS。 */
export const exportPreflightTesting={unresponsiveMs:UNRESPONSIVE_READ_MS};

/** Match the renderer's full asset inventory, including components and references.
 * Keep leases until the final check so changes during a multi-file scan are caught.
 * Rendering still obtains and verifies its own leases for changes after this scan.
 * 応答しない読み（開く処理が戻らない・読みが進まない）は exportPreflightTesting.unresponsiveMs で見限り、素材名と場所つきの問題として返す。
 * 最初の1件で確認を打ち切る（同じドライブの残りの素材ごとに上限まで待たせない。どれか1件でも問題があれば書き出しは始まらない）。 */
export async function preflightSequenceExport(project:string,document:SequenceDocument,signal?:AbortSignal):Promise<NativeExportPreflight>{
 const result:NativeExportPreflight={checked:0,referenceCount:document.assets.filter(a=>isSequenceReferenceFile(a.file)).length,issues:[]};
 const leases:Array<{asset:SequenceAsset;lease:SequenceAssetLease}>=[];
 const failed=(asset:SequenceAsset,cause:unknown)=>{
  signal?.throwIfAborted();
  if(cause instanceof UnresponsiveFileError){
   console.warn(`[sme] 書き出し前の確認: 「${asset.name}」の読み込みが ${(cause.waitedMs/1000).toFixed(1)} 秒応答しないため打ち切りました（${cause.operation}）:`,cause.path);
   result.issues.push({assetId:asset.id,name:asset.name,message:unresponsiveReadMessage(cause.path)});return;
  }
  const code=(cause as NodeJS.ErrnoException)?.code;
  const message=code==='ENOENT'||code==='ENODEV'?'素材が見つかりません。外付けドライブの接続や保存場所を確認してください。'
   :code?'素材を読み取れません。接続とアクセス権を確認してください。'
   :cause instanceof Error?cause.message:'素材を確認できませんでした。';
  result.issues.push({assetId:asset.id,name:asset.name,message});
 };
 try{
  const limit={unresponsiveMs:exportPreflightTesting.unresponsiveMs};
  for(const asset of document.assets){
   signal?.throwIfAborted();
   let unresponsive=false;
   try{if(asset.kind==='component')await readSequenceComponent(project,asset,limit);else leases.push({asset,lease:await openSequenceAsset(project,asset,signal,limit)});}
   catch(cause){failed(asset,cause);unresponsive=cause instanceof UnresponsiveFileError;}
   result.checked++;if(unresponsive)break;
  }
  for(const {asset,lease} of leases){try{await lease.verify();}catch(cause){failed(asset,cause);}}
  signal?.throwIfAborted();return result;
 }finally{await Promise.all(leases.map(({lease})=>lease.close()));}
}

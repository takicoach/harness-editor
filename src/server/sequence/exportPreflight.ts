import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import type {NativeExportPreflight} from '../../shared/nativeExport';
import {openSequenceAsset,type SequenceAssetLease} from './assets';
import {readSequenceComponent} from './components';
import {isSequenceReferenceFile} from './references';

/** Match the renderer's full asset inventory, including components and references.
 * Keep leases until the final check so changes during a multi-file scan are caught.
 * Rendering still obtains and verifies its own leases for changes after this scan. */
export async function preflightSequenceExport(project:string,document:SequenceDocument,signal?:AbortSignal):Promise<NativeExportPreflight>{
 const result:NativeExportPreflight={checked:0,referenceCount:document.assets.filter(a=>isSequenceReferenceFile(a.file)).length,issues:[]};
 const leases:Array<{asset:SequenceAsset;lease:SequenceAssetLease}>=[];
 const failed=(asset:SequenceAsset,cause:unknown)=>{
  signal?.throwIfAborted();
  const code=(cause as NodeJS.ErrnoException)?.code;
  const message=code==='ENOENT'||code==='ENODEV'?'素材が見つかりません。外付けドライブの接続や保存場所を確認してください。'
   :code?'素材を読み取れません。接続とアクセス権を確認してください。'
   :cause instanceof Error?cause.message:'素材を確認できませんでした。';
  result.issues.push({assetId:asset.id,name:asset.name,message});
 };
 try{
  for(const asset of document.assets){
   signal?.throwIfAborted();
   try{if(asset.kind==='component')await readSequenceComponent(project,asset);else leases.push({asset,lease:await openSequenceAsset(project,asset,signal)});}
   catch(cause){failed(asset,cause);}
   result.checked++;
  }
  for(const {asset,lease} of leases){try{await lease.verify();}catch(cause){failed(asset,cause);}}
  signal?.throwIfAborted();return result;
 }finally{await Promise.all(leases.map(({lease})=>lease.close()));}
}

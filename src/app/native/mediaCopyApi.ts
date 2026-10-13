import type {CopyDestinationRequest,CopyDestinationView,CopyJobView,SlowMediaAdvice} from '../../shared/mediaCopy';
import type {ImportBatchView,ImportDecisionChoice} from '../../shared/importBatches';
import {NativeApiError,nativeRequest} from './api';

/** コピーの対象: 開いた時（リンク素材）か、追加時の判断待ちの束。 */
export type CopyTargets={assetIds:string[]}|{batchId:string};
/** 遅い媒体の素材のコピーの窓口（src/server/sequence/mediaCopy/api.ts）。失敗の理由はサーバが日本語の決まった文言にして返す（NativeApiError の message）。 */
export const fetchCopyDestinations=(projectId:string,targets:CopyTargets,customPath?:string)=>
  nativeRequest<{destinations:CopyDestinationView[];totalBytes:number}>(projectId,'/media-copy/destinations',{...targets,...(customPath?{customPath}:{})});
export const startMediaCopy=(projectId:string,assetIds:string[],destination:CopyDestinationRequest)=>nativeRequest<{job:CopyJobView}>(projectId,'/media-copy/start',{assetIds,destination});
export const cancelMediaCopy=(projectId:string,jobId:string)=>nativeRequest<{job:CopyJobView}>(projectId,'/media-copy/cancel',{jobId});
export const dismissMediaCopy=(projectId:string,jobId:string)=>nativeRequest<{ok:true}>(projectId,'/media-copy/dismiss',{jobId});
export const fetchSlowMediaAdvice=(projectId:string,signal?:AbortSignal)=>nativeRequest<SlowMediaAdvice>(projectId,'/media-copy/advice',undefined,signal);
export const suppressSlowMedia=(projectId:string,assetId:string)=>nativeRequest<{ok:true}>(projectId,'/media-copy/suppress',{assetId});
export const decideImportBatch=(projectId:string,batchId:string,choice:ImportDecisionChoice,destination?:CopyDestinationRequest)=>
  nativeRequest<ImportBatchView>(projectId,'/imports/decide',{batchId,choice,...(destination?{destination}:{})});
/** 画面に出す失敗の文: サーバの決まった文言（NativeApiError）だけ。通信の失敗など（英文を含みうる）は fallback にする。 */
export const copyErrorMessage=(error:unknown,fallback:string)=>error instanceof NativeApiError&&error.message?error.message:fallback;

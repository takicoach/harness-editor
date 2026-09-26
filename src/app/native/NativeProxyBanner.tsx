import {reportEditorError} from './notificationHistory';
import {useEffect,useState} from 'react';
import type {NativeProxyStatus} from '../../server/sequence/previewProxy';
import {nativeRequest} from './api';

export function NativeProxyBanner({projectId,sessionId,revision,onReady}:{projectId:string;sessionId:string;revision:number;onReady():void}){
  const [assets,setAssets]=useState<NativeProxyStatus[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refreshKey,setRefreshKey]=useState(0);
  useEffect(()=>{if(error)reportEditorError(projectId,'軽量化',error);},[projectId,error]);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      try{
        const result=await nativeRequest<{assets:NativeProxyStatus[]}>(projectId,'/proxies',undefined,controller.signal,{session:sessionId});
        if(!Array.isArray(result.assets))throw new Error('軽量化の判定結果が不正です');
        if(!controller.signal.aborted){setAssets(result.assets);setError('');}
      }catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:String(error));}
      finally{if(!controller.signal.aborted)timer=setTimeout(()=>{void refresh();},3000);}
    };
    void refresh();return()=>{controller.abort();clearTimeout(timer);};
  },[projectId,sessionId,revision,refreshKey]);
  const candidates=assets.filter(asset=>asset.recommended||asset.job||asset.error);
  if(!error&&!candidates.length)return null;
  return <span className="native-proxy-chips" role="status">{error?<span className="native-proxy-chip is-error" title={error}>軽量化に失敗<button className="btn-ghost" aria-label="再確認" onClick={()=>setRefreshKey(value=>value+1)}>再確認</button></span>
  :candidates.map(asset=>{
    const active=asset.job&&!['done','failed','cancelled'].includes(asset.job.phase);
    const label=asset.ready?'軽量版あり':asset.error??asset.job?.error?.message??(active?asset.job?.phase==='preparing'?'素材を確認中':`軽量化 ${asset.job?.percent??0}%`:'軽量化をおすすめ');
    return <span key={asset.assetId} className={`native-proxy-chip${asset.ready?' is-ready':''}`} title={`${asset.name}: ${label}`}>{label}
      {asset.ready?<button className="btn-tonal" aria-label="軽量版でプレビューを再読み込み" onClick={onReady}>使う</button>
      :!asset.error&&<button className="btn-ghost" disabled={busy||!!active} onClick={()=>{
        setBusy(true);void nativeRequest(projectId,'/proxy',{sessionId,assetId:asset.assetId}).then(()=>setRefreshKey(value=>value+1))
          .catch(error=>{const message=error instanceof Error?error.message:String(error);setError(message);}).finally(()=>setBusy(false));
      }}>{asset.job?.phase==='failed'?'再試行':'軽量化する'}</button>}
    </span>;
  })}</span>;
}

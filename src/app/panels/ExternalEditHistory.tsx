import {useEffect,useState} from 'react';
import type {ExternalEditRecord} from '../../server/sequence/externalEdits';

/** Disk-committed external work is independent of the terminal/standby connection. */
export function ExternalEditHistory({projectId}:{projectId:string}) {
  const [records,setRecords]=useState<ExternalEditRecord[]>([]),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      try{
        const response=await fetch(`/api/sequence/external-edits?${new URLSearchParams({id:projectId})}`,{signal:controller.signal});
        if(response.status===404)return; // Old-format projects have no native journal.
        const body=await response.json();if(!response.ok)throw new Error(body.error??'外部編集履歴を取得できません');
        if(!Array.isArray(body.records))throw new Error('外部編集履歴の応答形式が不正です');
        if(!controller.signal.aborted){setRecords(body.records);setError('');}
      }catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:String(error));}
      finally{if(!controller.signal.aborted)timer=setTimeout(()=>{void refresh();},2000);}
    };
    setRecords([]);setError('');void refresh();return()=>{controller.abort();clearTimeout(timer);};
  },[projectId]);
  return <>{error&&<p role="alert">{error}</p>}{records.map(record=><section className="preference-card" key={record.operationId}>
    <h3>{record.kind==='ai'?'AIによる編集':'外部による編集'}</h3>
    <p>{record.source} · {new Date(record.at).toLocaleString()} · {{pending:'適用待ち・保存結果を確認中',saved:'保存済み',conflict:'競合・未反映',failed:'失敗・未反映'}[record.status]}</p>
    <p>{record.summary}</p><p>保存版 {record.before.savedRevision} → {record.after.savedRevision}</p>
    <small>操作ID: {record.operationId}</small>
    {record.error&&<p>{record.error}</p>}
    <p>外部保存は現在のUndo履歴に含まれません。変更前は保存版 {record.before.savedRevision} です。戻すにはその版のバックアップが必要です。</p>
  </section>)}</>;
}

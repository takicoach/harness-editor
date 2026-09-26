import {useRef} from 'react';
import {useDialogEscape} from '../useDialogEscape';
import {useFocusTrap} from '../useFocusTrap';
import type {NotificationHistory} from './notificationHistory';

export function NativeNotifications({projectId,history,storageError,onClear,onClose}:{projectId:string;history:NotificationHistory;storageError:string;onClear():void;onClose():void}){
  const root=useRef<HTMLDivElement>(null);useDialogEscape(onClose);useFocusTrap(root);
  const download=()=>{
    const data={format:'harness-editor-feedback',version:1,projectId,exportedAt:new Date().toISOString(),browser:navigator.userAgent,notifications:history.records};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`editor-feedback-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <div className="preference-overlay"><div ref={root} className="preference-dialog" role="dialog" aria-modal="true" aria-labelledby="native-notifications-title">
    <header className="preference-header"><h2 id="native-notifications-title">通知・エラー履歴</h2><button onClick={onClose} aria-label="通知を閉じる">閉じる</button></header>
    <div className="preference-body">
      <p>このブラウザーに案件ごとに最新200種類を保存します。同じ通知は回数をまとめます。過去の記録は、現在も問題が続いていることを示すものではありません。</p>
      <p>フィードバックには「ログを書き出す」で保存したファイルを添付できます。案件名やエラーの内容が含まれます。</p>
      {storageError&&<p role="alert">{storageError}</p>}
      <button className="btn-primary" onClick={download}>ログを書き出す</button>{' '}
      <button className="btn-ghost" disabled={!history.records.length} onClick={()=>{if(window.confirm('この案件の通知履歴を削除しますか？'))onClear();}}>履歴を消去</button>
      {!history.records.length&&<p>通知はありません。</p>}
      {history.records.map(record=><section className="preference-card" key={record.id}>
        <strong>{{error:'エラー',warning:'警告',info:'お知らせ'}[record.severity]} · {record.source}</strong>
        <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{record.message}</p>
        <small>{new Date(record.lastAt).toLocaleString()} · {record.count}回{record.revision!==undefined?` · 編集版 ${record.revision}`:''}{record.frame!==undefined?` · ${record.frame}フレーム`:''}</small>
      </section>)}
    </div>
  </div></div>;
}

import {useCallback,useEffect,useRef,useState} from 'react';
import {appendNotification,emptyNotificationHistory,notificationStorageKey,readNotificationHistory,type EditorNotification} from './notificationHistory';

export function useNotificationHistory(projectId:string){
  const key=notificationStorageKey(projectId);
  const [history,setHistory]=useState(()=>{try{return readNotificationHistory(localStorage.getItem(key));}catch{return emptyNotificationHistory();}});
  const latest=useRef(history),storageBroken=useRef(false);latest.current=history;
  const [storageError,setStorageError]=useState('');
  const update=useCallback((transform:(current:ReturnType<typeof emptyNotificationHistory>)=>ReturnType<typeof emptyNotificationHistory>)=>{
    {
      let base=latest.current;try{if(!storageBroken.current)base=readNotificationHistory(localStorage.getItem(key));}catch{/* retain in-memory history */}
      const next=transform(base);
      try{localStorage.setItem(key,JSON.stringify(next));storageBroken.current=false;setStorageError('');}catch{storageBroken.current=true;setStorageError('通知を端末に保存できません。ページを閉じる前にログを書き出してください。');}
      latest.current=next;setHistory(next);
    }
  },[key]);
  useEffect(()=>{
    const read=()=>{try{setHistory(readNotificationHistory(localStorage.getItem(key)));}catch{setHistory(emptyNotificationHistory());}};
    read();const changed=(event:StorageEvent)=>{if(event.key===key)read();};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);
  },[key]);
  const add=useCallback((input:Pick<EditorNotification,'severity'|'source'|'message'|'revision'|'frame'>)=>update(history=>appendNotification(history,input)),[update]);
  useEffect(()=>{
    const receive=(event:Event)=>{
      const detail=(event as CustomEvent).detail;
      if(detail?.projectId===projectId&&typeof detail.message==='string'&&typeof detail.source==='string')add({severity:'error',source:detail.source,message:detail.message});
    };
    window.addEventListener('harness-editor-notification',receive);return()=>window.removeEventListener('harness-editor-notification',receive);
  },[projectId,add]);
  const markRead=useCallback(()=>update(history=>({...history,seenAt:Date.now()})),[update]);
  const clear=useCallback(()=>update(()=>emptyNotificationHistory()),[update]);
  return {history,storageError,add,markRead,clear,unread:history.records.filter(record=>record.lastAt>history.seenAt).length};
}

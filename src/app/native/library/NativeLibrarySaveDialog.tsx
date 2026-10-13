import {useEffect,useRef,useState} from 'react';
import {Icon} from '../../Icon';
import {useFocusTrap} from '../../useFocusTrap';
import {isEscape} from '../keyboard';

const NAME_MAX=120,DESC_MAX=2000;

/** 「素材置場に保存」ダイアログ。保存中は二重送信せず、失敗はサーバーの文言を出して開いたままにする。 */
export function NativeLibrarySaveDialog({assetName,onSave,onClose}:{assetName:string;onSave(name:string,desc:string):Promise<void>;onClose():void}){
  const root=useRef<HTMLDivElement>(null),nameInput=useRef<HTMLInputElement>(null),busyRef=useRef(false);
  const [name,setName]=useState(assetName),[desc,setDesc]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const close=useRef(onClose);close.current=onClose;
  useFocusTrap(root);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    nameInput.current?.focus();nameInput.current?.select();
    const key=(event:KeyboardEvent)=>{if(isEscape(event)){event.stopPropagation();if(!busyRef.current)close.current();}};
    window.addEventListener('keydown',key,true);
    return()=>{window.removeEventListener('keydown',key,true);previous?.focus();};
  },[]);
  const trimmed=name.trim();
  const submit=async()=>{
    if(busyRef.current||!trimmed)return;
    busyRef.current=true;setBusy(true);setError(null);
    try{await onSave(trimmed,desc.trim());close.current();}
    catch(failure){setError(failure instanceof Error?failure.message:String(failure));busyRef.current=false;setBusy(false);}
  };
  return <div className="native-dialog-backdrop" onClick={()=>{if(!busyRef.current)onClose();}}>
    <div ref={root} className="native-dialog native-library-save" role="dialog" aria-modal="true" aria-label="素材置場に保存" onClick={event=>event.stopPropagation()}>
      <div className="native-dialog-head"><strong>素材置場に保存</strong><button className="btn-ghost native-header-icon" aria-label="閉じる" disabled={busy} onClick={onClose}><Icon name="x"/></button></div>
      <form onSubmit={event=>{event.preventDefault();void submit();}}>
        <label className="native-library-save-field">名前<input ref={nameInput} type="text" value={name} maxLength={NAME_MAX} onChange={event=>setName(event.target.value)}/></label>
        <label className="native-library-save-field">説明（任意）<textarea value={desc} rows={3} maxLength={DESC_MAX} onChange={event=>setDesc(event.target.value)}/></label>
        {error&&<div className="native-library-save-error" role="alert">{error}</div>}
        <div className="native-library-save-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>キャンセル</button><button type="submit" className="btn-primary" disabled={busy||!trimmed}>保存</button></div>
      </form>
    </div>
  </div>;
}

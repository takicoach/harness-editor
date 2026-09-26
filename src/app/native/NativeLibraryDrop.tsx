import {useEffect,useRef,useState,type DragEvent,type ReactNode} from 'react';
import {Icon} from '../Icon';
import {isEscape} from './keyboard';
import './native-file-drop.css';

type Receipt={total:number;added:number|null};
const fileCount=(transfer:DataTransfer)=>Array.from(transfer.items??[]).filter(item=>item.kind==='file').length||transfer.files.length;
const hasFiles=(transfer:DataTransfer)=>Array.from(transfer.types??[]).includes('Files')||transfer.files.length>0;

/** Own external file drops without interfering with asset-to-timeline drags. */
export function NativeLibraryDrop({children,disabled,onFiles}:{children:ReactNode;disabled:boolean;onFiles(files:File[]):Promise<number>}) {
  const [hover,setHover]=useState<number|null>(null),[receipt,setReceipt]=useState<Receipt|null>(null);
  const depth=useRef(0),pending=useRef(false),mounted=useRef(true),timer=useRef<ReturnType<typeof setTimeout>>();
  const clearHover=()=>{depth.current=0;setHover(null);};
  useEffect(()=>{
    mounted.current=true;
    const key=(event:KeyboardEvent)=>{if(isEscape(event))clearHover();};
    window.addEventListener('dragend',clearHover);window.addEventListener('drop',clearHover);window.addEventListener('blur',clearHover);window.addEventListener('keydown',key);
    return()=>{mounted.current=false;clearTimeout(timer.current);window.removeEventListener('dragend',clearHover);window.removeEventListener('drop',clearHover);window.removeEventListener('blur',clearHover);window.removeEventListener('keydown',key);};
  },[]);
  const over=(event:DragEvent<HTMLElement>)=>{
    if(!hasFiles(event.dataTransfer))return;
    event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect=disabled||pending.current?'none':'copy';
    if(!pending.current){setReceipt(null);clearTimeout(timer.current);setHover(fileCount(event.dataTransfer));}
  };
  const drop=async(event:DragEvent<HTMLElement>)=>{
    if(!hasFiles(event.dataTransfer))return;
    event.preventDefault();event.stopPropagation();clearHover();
    const files=Array.from(event.dataTransfer.files);if(disabled||pending.current||!files.length)return;
    pending.current=true;clearTimeout(timer.current);setReceipt({total:files.length,added:null});
    let added=0;
    try{added=await onFiles(files);}catch{added=0;}finally{
      pending.current=false;
      if(mounted.current){setReceipt({total:files.length,added});timer.current=setTimeout(()=>setReceipt(null),added===files.length?1200:2400);}
    }
  };
  const phase=receipt?(receipt.added===null?'importing':receipt.added===receipt.total?'complete':'incomplete'):hover!==null?(disabled?'blocked':'ready'):'idle';
  const label=phase==='ready'?`${hover?`${hover}件の`:''}素材を追加`:phase==='blocked'?'いまは追加できません':phase==='importing'?`${receipt!.total}件の素材を取り込み中`:phase==='complete'?`${receipt!.added}件の素材を追加しました`:receipt?.added?`${receipt.added} / ${receipt.total}件を追加しました`:'素材を追加できませんでした';
  return <aside className="native-library" aria-label="プロジェクトと素材" data-drop-state={phase}
    onDragEnter={event=>{if(hasFiles(event.dataTransfer)){depth.current++;over(event);}}} onDragOver={over}
    onDragLeave={()=>{if(!depth.current)return;depth.current--;if(!depth.current)clearHover();}}
    onDrop={event=>{void drop(event);}}>
    {children}
    {phase!=='idle'&&<div className="native-file-drop" role="status" aria-live="polite" aria-atomic="true">
      <div className="native-file-drop-stack" aria-hidden="true">
        <span className="native-file-drop-card is-back"/><span className="native-file-drop-card is-middle"/>
        <span className="native-file-drop-card is-front"><Icon name={phase==='complete'?'check':phase==='blocked'||phase==='incomplete'?'x':'plus'} size={26}/></span>
        {phase==='ready'&&!!hover&&<span className="native-file-drop-count">{hover}</span>}
      </div>
      <strong>{label}</strong>
      <span className="native-file-drop-hint">{phase==='ready'?'ここで離すと取り込めます':phase==='importing'?'そのままお待ちください':phase==='complete'?'素材一覧から使えます':phase==='blocked'?'処理が終わってから、もう一度どうぞ':'取り込み結果を確認してください'}</span>
    </div>}
  </aside>;
}

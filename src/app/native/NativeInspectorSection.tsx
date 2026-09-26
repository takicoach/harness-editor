import {useId,useState,type ReactNode} from 'react';
import {Icon} from '../Icon';

interface Props {label:string;setting:string;initiallyOpen?:boolean;beforeClose():Promise<boolean>;children:ReactNode;
  /** 畳んでいる間だけ見出しに出す要約（F14）。 */
  summary?:string;
  /** 群（F14）のときは data-setting ではなく data-group を付ける。仕上げフィルタ（data-setting を見る）に群が引っかからないため。 */
  group?:boolean;
  /** 親が開閉を持つとき（viewState に記憶する）。省略時は自前で持つ。 */
  open?:boolean;onOpenChange?(open:boolean):void}

/** Folding is view-only; fields stay mounted and drafts finish before they are hidden. */
export function NativeInspectorSection({label,setting,summary,group=false,beforeClose,children,initiallyOpen=true,open:controlled,onOpenChange}:Props) {
  const [local,setLocal]=useState(initiallyOpen),[closing,setClosing]=useState(false);
  const open=controlled??local;
  const setOpen=(next:boolean)=>{setLocal(next);onOpenChange?.(next);};
  const id=useId();
  async function toggle(){
    if(!open){setOpen(true);return;}
    setClosing(true);
    try {if(await beforeClose())setOpen(false);} finally {setClosing(false);}
  }
  return <section className="native-inspector-section" data-setting={group?undefined:setting} data-group={group?setting:undefined}>
    <h3><button type="button" aria-expanded={open} aria-controls={id} disabled={closing} onClick={()=>void toggle()}>
      <span className="native-inspector-section-label">{label}</span>
      {!open&&summary&&<span className="native-inspector-section-summary">{summary}</span>}
      <Icon name="chevron-down" size={14}/>
    </button></h3>
    <div id={id} hidden={!open}>{children}</div>
  </section>;
}

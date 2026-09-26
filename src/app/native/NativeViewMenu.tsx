import {useCallback,useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Icon} from '../Icon';
import {isEscape} from './keyboard';

/**
 * ツールバー右端の「表示」ポップオーバー（F4）。幅が足りないときだけ使い、中身は
 * .native-timeline-options をそのまま入れる。外側クリックと Esc で閉じる（NativeAddBar のメニューと同じ作法）。
 *
 * Codex P2: タイムライン高さが下限（180px）のとき、木のまま描くと `.native-timeline-panel{overflow:hidden}`
 * に下側の項目（ズーム・全体）が切られて押せない。NativeFolderPicker / NativeTextStyleList と同じ方針で
 * `.native-workspace` へポータルし、起点ボタンの getBoundingClientRect() から position:fixed で位置を
 * 計算する。下端が viewport を超えるなら上開き、高さは viewport 内に収めて overflow:auto にする。
 */
export function NativeViewMenu({children,label='表示'}:{children:ReactNode;label?:string}){
  const [open,setOpen]=useState(false);
  const id=useId();
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const [box,setBox]=useState<{top?:number;bottom?:number;right:number;maxHeight:number}|null>(null);
  const measure=useCallback(()=>{
    const node=trigger.current;if(!node)return;
    const margin=12,minHeight=140;
    const r=node.getBoundingClientRect();
    const spaceBelow=window.innerHeight-r.bottom-margin;
    const spaceAbove=r.top-margin;
    const openUp=spaceBelow<minHeight&&spaceAbove>spaceBelow;
    const maxHeight=Math.max(minHeight,Math.min(360,openUp?spaceAbove:spaceBelow));
    const right=Math.max(margin,window.innerWidth-r.right);
    const next=openUp
      ?{bottom:Math.max(margin,window.innerHeight-r.top+6),right,maxHeight}
      :{top:Math.max(margin,r.bottom+6),right,maxHeight};
    // 同値なら差し替えない（新しいオブジェクトを入れるだけで中身が再描画される）。
    setBox(previous=>previous&&previous.top===next.top&&previous.bottom===next.bottom&&previous.right===next.right&&previous.maxHeight===next.maxHeight?previous:next);
  },[]);
  useLayoutEffect(()=>{if(open)measure();},[open,measure]);
  useEffect(()=>{
    if(!open)return;
    const down=(event:PointerEvent)=>{
      if(!(event.target instanceof Node))return;
      if(panel.current?.contains(event.target)||trigger.current?.contains(event.target))return;
      // T8: メニューの中にフォーカスがあるまま閉じると body へ落ちる。起点へ戻す（外にある時は触らない）。
      const inside=panel.current?.contains(window.document.activeElement);
      setOpen(false);
      if(inside)trigger.current?.focus();
    };
    document.addEventListener('pointerdown',down);
    return()=>document.removeEventListener('pointerdown',down);
  },[open]);
  useEffect(()=>{
    if(!open)return;
    // ポータルなので起点ボタン（外側）から中の onKeyDown へは届かない。document の capture で拾う。
    const key=(event:KeyboardEvent)=>{if(!isEscape(event))return;event.preventDefault();event.stopPropagation();setOpen(false);trigger.current?.focus();};
    document.addEventListener('keydown',key,true);
    return()=>document.removeEventListener('keydown',key,true);
  },[open]);
  useLayoutEffect(()=>{if(open)panel.current?.querySelector<HTMLElement>('.native-view-menu-panel button, .native-view-menu-panel input')?.focus();},[open,box]);
  useEffect(()=>{
    if(!open)return;
    // fixed なので、窓の大きさが変わってもタイムラインが伸縮しても起点はずれる。開いている間だけ追う。
    const again=(event?:Event)=>{if(event?.target instanceof Node&&panel.current?.contains(event.target))return;measure();};
    window.addEventListener('resize',again);document.addEventListener('scroll',again,true);
    return()=>{window.removeEventListener('resize',again);document.removeEventListener('scroll',again,true);};
  },[open,measure]);
  return <div className="native-view-menu">
    <button ref={trigger} type="button" className="btn-secondary" aria-expanded={open} aria-controls={open?id:undefined} aria-haspopup="true" data-tip="表示の設定" onClick={()=>setOpen(value=>!value)}><Icon name="sliders"/>{label}</button>
    {open&&box&&createPortal(<div id={id} ref={panel} className="native-view-menu-panel" role="group" aria-label={label}
      style={{position:'fixed',right:box.right,maxHeight:box.maxHeight,overflow:'auto',...(box.top!==undefined?{top:box.top}:{bottom:box.bottom})}}>
      {children}
    </div>,trigger.current?.closest('.native-workspace')??window.document.body)}
  </div>;
}

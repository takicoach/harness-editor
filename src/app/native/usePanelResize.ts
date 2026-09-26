import {useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent} from 'react';

/** Panel sizing is a gesture owned by one pointer, never a persistent hover mode. */
export function usePanelResize() {
  const drag = useRef<{pointerId:number; target:HTMLElement; move:(event:ReactPointerEvent<HTMLElement>)=>void}|null>(null);
  const stop = useCallback(() => {
    const current=drag.current;
    drag.current=null;
    if(current?.target.hasPointerCapture(current.pointerId))current.target.releasePointerCapture(current.pointerId);
  },[]);
  useEffect(()=>{
    const end=(event:PointerEvent)=>{if(drag.current?.pointerId===event.pointerId)stop();};
    const hidden=()=>{if(document.hidden)stop();};
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&drag.current){stop();event.preventDefault();event.stopPropagation();}};
    window.addEventListener('pointerup',end,true);
    window.addEventListener('pointercancel',end,true);
    window.addEventListener('blur',stop);
    window.addEventListener('keydown',key,true);
    document.addEventListener('visibilitychange',hidden);
    return ()=>{
      stop();
      window.removeEventListener('pointerup',end,true);
      window.removeEventListener('pointercancel',end,true);
      window.removeEventListener('blur',stop);
      window.removeEventListener('keydown',key,true);
      document.removeEventListener('visibilitychange',hidden);
    };
  },[stop]);
  return {
    start(event:ReactPointerEvent<HTMLElement>,move:(event:ReactPointerEvent<HTMLElement>)=>void){
      if(event.button!==0||drag.current)return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current={pointerId:event.pointerId,target:event.currentTarget,move};
    },
    onPointerMove(event:ReactPointerEvent<HTMLElement>){
      const current=drag.current;
      if(!current||event.pointerId!==current.pointerId)return;
      if((event.buttons&1)===0){stop();return;}
      current.move(event);
    },
    onLostPointerCapture(event:ReactPointerEvent<HTMLElement>){if(drag.current?.pointerId===event.pointerId)stop();},
  };
}

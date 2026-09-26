import {useCallback,useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react';
import {clampZoom,MIN_PX_PER_FRAME} from '../timeline/timelineGeometry';
import {edgeScrollFrameScale,edgeScrollVelocity,followScrollLeft,wheelAction,zoomAnchoredScrollLeft} from '../timeline/timelineScroll';
import {hoverEdgeScrollDelta} from './nativeEdgeScroll';
import {nativeFitZoom,nativeMinZoom} from './nativeFitZoom';

export const NATIVE_TIMELINE_GUTTER=132;
interface Options {
  scroller:RefObject<HTMLDivElement>;zoom:number;frame:number;playing:boolean;busy:boolean;
  projectId:string;documentId:string;mode?:string;
  /** 表示総フレーム（末尾 5 秒の余白を含まない）。fit ズームの分母。 */
  totalFrames:number;
  onZoomChange?:(zoom:number)=>void;
  dragging:boolean;
  /** ドラッグしていないときも端ホバーで送るか（再生追従中・ドラッグ中は呼び出し側が false にする）。 */
  hoverEdgeScroll:boolean;
  pointer():{x:number;y:number;moved:boolean}|null;
  onDragScroll():void;cancel():void;
}
export interface NativeTimelineViewport {fitZoom():void;minZoom:number}
/** Only viewport pixels change here. Playback and persisted clip clocks stay owned by their existing APIs. */
export function useNativeTimelineViewport(options:Options):NativeTimelineViewport {
  const live=useRef(options),previous=useRef({zoom:options.zoom,frame:options.frame});
  const pending=useRef<{zoom:number;anchorContentX:number;viewportOffset:number}|null>(null);
  const hover=useRef<{x:number;y:number}|null>(null);
  // ループを起動するかどうかは state で決める。ref だけだと枠外へ出ても rAF が回り続け、
  // 毎フレーム getBoundingClientRect() を呼ぶ空転になる。
  const [hovering,setHovering]=useState(false);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{pending.current=null;previous.current={zoom:options.zoom,frame:options.frame};},[options.projectId,options.documentId,options.mode]);
  useLayoutEffect(()=>{
    const old=previous.current,element=options.scroller.current;
    previous.current={zoom:options.zoom,frame:options.frame};
    if(!element||old.zoom===options.zoom)return;
    const requested=pending.current;pending.current=null;
    const content=NATIVE_TIMELINE_GUTTER+old.frame*old.zoom;
    const visible=content-element.scrollLeft;
    const anchor=requested?.zoom===options.zoom?requested:{anchorContentX:content,viewportOffset:visible>=NATIVE_TIMELINE_GUTTER&&visible<=element.clientWidth?visible:(element.clientWidth+NATIVE_TIMELINE_GUTTER)/2};
    element.scrollLeft=zoomAnchoredScrollLeft({...anchor,ratio:options.zoom/old.zoom,gutter:NATIVE_TIMELINE_GUTTER,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth});
  },[options.zoom,options.frame,options.scroller]);
  useLayoutEffect(()=>{
    const element=options.scroller.current;
    if(element&&options.playing&&!options.busy)element.scrollLeft=followScrollLeft(NATIVE_TIMELINE_GUTTER+options.frame*options.zoom,element.clientWidth,element.scrollWidth);
  },[options.frame,options.playing,options.busy,options.zoom,options.scroller]);
  useEffect(()=>{
    const element=options.scroller.current;if(!element)return;
    const wheel=(event:WheelEvent)=>{
      const current=live.current,action=wheelAction(event);
      if(action.kind==='zoom'&&current.onZoomChange){
        event.preventDefault();if(current.busy||event.deltaY===0)return;
        current.cancel();
        const next=clampZoom(current.zoom*action.factor);if(next===current.zoom)return;
        const viewportOffset=event.clientX-element.getBoundingClientRect().left;
        pending.current={zoom:next,anchorContentX:element.scrollLeft+viewportOffset,viewportOffset};
        current.onZoomChange(next);
      }else if(action.kind==='pan'){
        event.preventDefault();element.scrollLeft=Math.max(0,Math.min(element.scrollWidth-element.clientWidth,element.scrollLeft+action.dx));
        current.onDragScroll();
      }
    };
    const scroll=()=>live.current.onDragScroll();
    const enter=(event:PointerEvent)=>{hover.current={x:event.clientX,y:event.clientY};setHovering(true);};
    const leave=()=>{hover.current=null;setHovering(false);};
    element.addEventListener('wheel',wheel,{passive:false});element.addEventListener('scroll',scroll,{passive:true});
    element.addEventListener('pointermove',enter,{passive:true});element.addEventListener('pointerleave',leave,{passive:true});
    return()=>{element.removeEventListener('wheel',wheel);element.removeEventListener('scroll',scroll);
      element.removeEventListener('pointermove',enter);element.removeEventListener('pointerleave',leave);};
  },[options.scroller]);
  // ドラッグを離した直後は、最後のホバー位置で走り続けないよう捨てる（右端で離して止まらない対策）。
  // 次の pointermove で入り直すまでホバー端は起動しない。
  useEffect(()=>{
    if(!options.dragging)return;
    return()=>{hover.current=null;setHovering(false);};
  },[options.dragging]);
  useEffect(()=>{
    if(!options.dragging&&!(options.hoverEdgeScroll&&hovering))return;
    let handle=0,previousTime:number|null=null;
    const tick=(timestamp:number)=>{
      const current=live.current,element=current.scroller.current;
      if(!element){handle=requestAnimationFrame(tick);return;}
      const dt=previousTime===null?null:timestamp-previousTime;previousTime=timestamp;
      const point=current.pointer(),bounds=element.getBoundingClientRect();
      let speed=0;
      if(current.dragging&&point){
        // ドラッグ中は掴んだ位置を追いかける。枠の上下外でも横は送り続ける（従来どおり）。
        if(point.moved&&!current.playing&&!current.busy&&point.y>=bounds.top&&point.y<=bounds.bottom)
          speed=edgeScrollVelocity(point.x,bounds.left+NATIVE_TIMELINE_GUTTER,bounds.right)*edgeScrollFrameScale(dt);
      }else if(current.hoverEdgeScroll&&hover.current&&!current.playing&&!current.busy){
        speed=hoverEdgeScrollDelta({pointerX:hover.current.x,pointerY:hover.current.y,rect:bounds,gutter:NATIVE_TIMELINE_GUTTER,dtMs:dt});
      }
      if(speed){
        const next=Math.max(0,Math.min(Math.max(0,element.scrollWidth-element.clientWidth),element.scrollLeft+speed));
        if(next!==element.scrollLeft){element.scrollLeft=next;current.onDragScroll();}
      }
      handle=requestAnimationFrame(tick);
    };
    handle=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(handle);
  },[options.dragging,options.hoverEdgeScroll,hovering]);
  const [minZoom,setMinZoom]=useState(MIN_PX_PER_FRAME);
  const fitted=useRef('');
  const fitZoom=useCallback(()=>{
    const current=live.current,element=current.scroller.current;if(!element)return;
    const next=nativeFitZoom(current.totalFrames,element.clientWidth);
    if(next!==null&&next!==current.zoom)current.onZoomChange?.(next);
  },[]);
  // スライダーの床（minZoom の表示）は totalFrames や幅が変わるたびに更新する。ここではズームには
  // 触れない — 触れると、案件を短くする編集（例: 延長ドラッグの undo）のたびにユーザーが選んだズームが
  // 無言で全体表示へ引き戻されてしまう（T9 で発覚: ghost-loop-extension の undo 直後、totalFrames が
  // 縮んだだけで long-loop-scroll のズームが 8→12 へ勝手に戻り、幅の期待値が壊れた）。
  useLayoutEffect(()=>{
    const element=options.scroller.current;if(!element)return;
    const floor=nativeFitZoom(options.totalFrames,element.clientWidth);if(floor===null)return;
    const sliderFloor=nativeMinZoom(options.totalFrames,element.clientWidth)??floor;
    setMinZoom(previous=>previous===sliderFloor?previous:sliderFloor);
  },[options.scroller,options.totalFrames]);
  // ズームを実際に動かすのはここだけ: (1) 案件を開いた直後（プロジェクト/ドキュメント/モードが変わった
  // 直後）に一度だけ全体表示へ合わせる、(2) 本物のビューポートのリサイズで今のズームが床より下がったら
  // 引き上げる。ResizeObserver はプロジェクト/ドキュメント/モードが変わった時だけ張り直す — totalFrames
  // の変化のたびに張り直すと、observe() 直後にブラウザが送る「現在サイズの初回通知」が編集のたびの
  // 偽リサイズ扱いになり、上と同じ問題を resize 経路からも起こしてしまう。
  useLayoutEffect(()=>{
    const element=options.scroller.current;if(!element)return;
    const evaluate=()=>{
      const target=options.scroller.current;if(!target)return;
      const current=live.current,floor=nativeFitZoom(current.totalFrames,target.clientWidth);
      if(floor===null)return;
      const sliderFloor=nativeMinZoom(current.totalFrames,target.clientWidth)??floor;
      setMinZoom(previous=>previous===sliderFloor?previous:sliderFloor);
      const key=`${current.projectId}:${current.documentId}:${current.mode??''}`,firstFit=fitted.current!==key;
      if(firstFit)fitted.current=key;
      if((firstFit||current.zoom<floor)&&floor!==current.zoom)current.onZoomChange?.(floor);
    };
    const observer=new ResizeObserver(evaluate);observer.observe(element);evaluate();
    return()=>observer.disconnect();
  },[options.scroller,options.projectId,options.documentId,options.mode]);
  return {fitZoom,minZoom};
}

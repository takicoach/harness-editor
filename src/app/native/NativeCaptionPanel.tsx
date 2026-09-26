import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import type {NativeCommand,NativeSession} from './api';
import {clipEnd} from '../../core/sequence/model';
import {timeNumber} from '../../core/sequence/time';
import {captionClips,captionTextCommand,captionTime,mergeCaptionCommand,nextCaption,splitCaptionCommand} from './captionEditing';
import {isCaptionCut} from './cutPresentation';
import {captionWordChips} from './wordChips';
import {loadCaptionFollow,saveCaptionFollow} from '../layout/captionFollowPref';
import {TaskProgress} from '../components/TaskProgress';
import './native-caption-panel.css';

export interface NativeCaptionHandle {flush():Promise<boolean>}
interface Props {
  projectId:string;state:NativeSession;busy:boolean;switching?:boolean;frame:number;playing:boolean;selected:string[];
  read():NativeSession|null;prepare():Promise<boolean>;execute(command:NativeCommand):Promise<boolean>;
  onCollapse(id:string):void;onDraft(dirty:boolean):void;onSelect(id:string,frame:number):void;onStyle(id:string):void;
}
type Draft={base:string;text:string};
/** Pause in typing that counts as "the sentence is finished". One pause = one flush = one undo. */
const AUTO_APPLY_MS=1500;
export const NativeCaptionPanel=forwardRef<NativeCaptionHandle,Props>(function NativeCaptionPanel(props,ref){
  const drafts=useRef(new Map<string,Draft>()),latest=useRef(props);latest.current=props;
  const [,redraw]=useState(0),[error,setError]=useState<string|null>(null),[working,setWorking]=useState(false),[applying,setApplying]=useState(false);
  const pending=useRef<Promise<boolean>|null>(null),actionPending=useRef(false),epoch=useRef(0),mounted=useRef(true);
  const owner=useRef({projectId:props.projectId,sessionId:props.state.sessionId});
  const rows=useRef(new Map<string,HTMLElement>()),manualUntil=useRef(0),panel=useRef<HTMLElement>(null);
  // Auto-apply: one pause in typing (or leaving the box) sends every draft as one
  // command, so a stopped sentence costs the reader exactly one undo.
  const idleTimer=useRef<ReturnType<typeof setTimeout>|null>(null),composing=useRef(false);
  const cancelIdle=()=>{if(idleTimer.current!==null){clearTimeout(idleTimer.current);idleTimer.current=null;}};
  // Japanese input builds a word across many change events; counting the pause from
  // compositionend keeps half-converted kana out of the document.
  const scheduleIdle=()=>{cancelIdle();if(composing.current)return;idleTimer.current=setTimeout(()=>{idleTimer.current=null;void flush();},AUTO_APPLY_MS);};
  const stillComposing=(event:{nativeEvent:object})=>composing.current||('isComposing' in event.nativeEvent&&event.nativeEvent.isComposing===true);
  const [follow,setFollow]=useState(loadCaptionFollow);
  useEffect(()=>{
    // Transcript controls and captions share one scrolling pane. Wheel input
    // over either part must temporarily take priority over playback following.
    const host=panel.current?.closest('.native-right-content')??panel.current;if(!host)return;
    const manual=()=>{manualUntil.current=Date.now()+4000;};
    host.addEventListener('wheel',manual,{passive:true,capture:true});
    return()=>host.removeEventListener('wheel',manual,true);
  },[]);
  const changed=()=>{redraw(v=>v+1);latest.current.onDraft(drafts.current.size>0||actionPending.current);};
  useEffect(()=>{
    const previous=owner.current;owner.current={projectId:props.projectId,sessionId:props.state.sessionId};
    if(previous.projectId!==props.projectId||previous.sessionId!==props.state.sessionId){
      // A pending pause belongs to the session it was typed in. Reconnecting keeps the drafts
      // (same project) but not the document they were measured against, so the timer must die
      // here exactly as it does on unmount — otherwise it applies old text to a new session.
      cancelIdle();composing.current=false;
      epoch.current++;pending.current=null;actionPending.current=false;setWorking(false);setApplying(false);
      if(previous.projectId!==props.projectId){drafts.current.clear();setError(null);}
      changed();
    }
  },[props.projectId,props.state.sessionId]);
  useEffect(()=>{
    // Acknowledged text clears only its matching draft; another edit never replaces it.
    for(const [id,draft] of drafts.current){
      const clip=captionClips(props.state.document).find(c=>c.id===id);
      if(clip?.content.data.text===draft.text)drafts.current.delete(id);
    }
    changed();
  },[props.state.document.revision]);
  useEffect(()=>{
    mounted.current=true;
    const unload=(event:BeforeUnloadEvent)=>{if(drafts.current.size||actionPending.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',unload);
    return()=>{mounted.current=false;epoch.current++;cancelIdle();window.removeEventListener('beforeunload',unload);latest.current.onDraft(false);};
  },[]);
  async function flush():Promise<boolean>{
    cancelIdle(); // A flush from any trigger retires the pending pause; it never doubles into a second undo step.
    if(pending.current){if(!await pending.current)return false;return flush();}
    if(!drafts.current.size){setApplying(false);return true;}
    const token=epoch.current,current=latest.current;
    const owns=()=>mounted.current&&epoch.current===token;
    const task=(async()=>{
      try{
        if(!await current.prepare()||!owns())return false;
        const state=latest.current.read();if(!state||state.sessionId!==latest.current.state.sessionId)return false;
        // Match the shared API's 50-leaf limit. A successful slice retires only
        // its own drafts; flush then rebuilds the next slice at the new revision.
        const commands:NativeCommand[]=[],submitted=new Map([...drafts.current].slice(0,50));
        for(const [id,draft] of submitted){
          const clip=captionClips(state.document).find(c=>c.id===id);
          if(!clip)throw new Error('編集中の字幕が別の操作で削除されました。入力した本文は下に残しています。');
          if(clip.content.data.text===draft.text)continue;
          if(clip.content.data.text!==draft.base)throw new Error('別の操作で字幕本文が変わりました。入力を確認し、現在の本文を使うか選んでください。');
          commands.push(captionTextCommand(state.document,id,draft.text));
        }
        const ok=!commands.length||await latest.current.execute({type:'batch',commands:commands as import('../../core/sequence/commands').SequenceCommand[]});
        if(!owns())return false;
        if(!ok){setError('字幕を反映できませんでした。入力はこの画面に残っています。');return false;}
        for(const [id,draft] of submitted){const now=drafts.current.get(id);if(now?.text===draft.text)drafts.current.delete(id);else if(now)now.base=draft.text;}
        changed();setError(null);return true;
      }catch(cause){if(owns())setError(cause instanceof Error?cause.message:String(cause));return false;}
    })();pending.current=task;setApplying(true);
    const ok=await task;if(pending.current===task)pending.current=null;
    if(!(ok&&owns())){setApplying(false);return false;}
    return flush();
  }
  useImperativeHandle(ref,()=>({flush}));
  async function action(id:string,kind:'split'|'merge'|'cut'|'delete'){
    if(actionPending.current||latest.current.busy)return;
    actionPending.current=true;setWorking(true);changed();
    const token=epoch.current;
    try{
      if(!await flush()||!await latest.current.prepare()||epoch.current!==token)return;
      const current=latest.current,state=current.read();if(!state)return;
      const clip=captionClips(state.document).find(c=>c.id===id);if(!clip)throw new Error('対象の字幕がありません。');
      const result=kind==='split'?splitCaptionCommand(state.document,id,current.frame):kind==='merge'?mergeCaptionCommand(state.document,id):
        {command:kind==='cut'?{type:'ripple-delete' as const,startFrame:clip.startFrame,endFrame:clipEnd(clip)}:{type:'delete' as const,clipIds:[id],linked:false},selectedId:id};
      const ok=await current.execute(result.command);
      if(epoch.current!==token||!mounted.current)return;
      if(ok){setError(null);const next=current.read()?.document.clips.find(c=>c.id===result.selectedId);if(next)current.onSelect(next.id,next.startFrame);}
      else setError('変更を反映できませんでした。もう一度確認してください。');
    }catch(cause){if(epoch.current===token&&mounted.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(epoch.current===token&&mounted.current){actionPending.current=false;setWorking(false);changed();}}
  }
  const clips=captionClips(props.state.document),active=clips.find(c=>c.content.kind==='telop'&&c.content.data.manual!==true&&c.startFrame<=props.frame&&props.frame<clipEnd(c));
  useEffect(()=>{
    if(follow&&props.playing&&active&&!drafts.current.size&&Date.now()>manualUntil.current)
      rows.current.get(active.id)?.scrollIntoView?.({block:'nearest'});
  },[active?.id,follow,props.playing,props.frame]);
  const selectedId=props.selected.find(id=>clips.some(c=>c.id===id));
  useEffect(()=>{
    if(selectedId)rows.current.get(selectedId)?.scrollIntoView?.({block:'nearest'});
  },[selectedId]);
  // Buttons keep the old guard and add the in-flight apply: every row action flushes first,
  // so offering them mid-apply only invites a contended second command. The textarea is the
  // one control excluded from this — see its comment below.
  const disabled=props.busy||working||applying;
  return <section ref={panel} className="native-caption-panel" aria-label="字幕のテキスト編集" data-native-script-flush>
    <header><h3>字幕一覧 <span className="native-caption-count">{clips.length}件</span></h3>
      <label><input type="checkbox" aria-label="再生に追従" checked={follow} onChange={event=>{const value=event.target.checked;setFollow(value);saveCaptionFollow(value);}}/>再生に追従</label></header>
    <p className="native-subtle">行を押すと字幕へ移動して本文を編集できます。同じ行をもう一度押すと閉じます。</p>
    {working&&<TaskProgress label="字幕を反映しています"/>}
    {error&&<p role="alert">{error}</p>}
    {clips.map(clip=>{
      const draft=drafts.current.get(clip.id),text=draft?.text??clip.content.data.text,conflict=!!draft&&draft.base!==clip.content.data.text&&draft.text!==clip.content.data.text;
      const decoration=clip.content.kind==='title'||clip.content.data.manual===true;
      const expanded=props.selected.includes(clip.id);
      const cut=isCaptionCut(props.state.document,clip);
      return <article key={clip.id} ref={node=>{if(node)rows.current.set(clip.id,node);else rows.current.delete(clip.id);}}
        className={`${expanded?'is-selected':''} ${active?.id===clip.id?'is-playing':''} ${cut?'is-cut':''}`}
        onClick={event=>{
          if((event.target as HTMLElement).closest('button,textarea,input,[role=alert]'))return;
          if(working||composing.current)return;
          if(expanded){
            const token=epoch.current;
            void flush().then(ok=>{if(ok&&mounted.current&&epoch.current===token)latest.current.onCollapse(clip.id);});
          }else props.onSelect(clip.id,clip.startFrame);
        }}>
        <div className="native-caption-row-heading">
          <span className="native-caption-time">{captionTime(props.state.document,clip.startFrame)}</span>
          <span className="native-caption-text">{text}</span>
          <small>{decoration?'装飾テロップ':'字幕'} {((clipEnd(clip)-clip.startFrame)/timeNumber(props.state.document.fps)).toFixed(1)}秒</small>
        </div>
        {expanded&&<>
          {/* Never disabled: disabling steals focus mid-sentence, and the draft map already
              holds keystrokes that arrive while an apply is in flight (flush recurses for them).
              Only a project/session switch, which discards drafts, freezes the text — read-only
              so the caret and focus survive it. */}
          <textarea aria-label={`字幕本文 ${clip.id}`} value={text} readOnly={!!props.switching} aria-busy={applying} rows={Math.min(5,Math.max(2,text.split('\n').length))}
            onChange={event=>{const value=event.target.value,base=draft?.base??clip.content.data.text;if(value===base)drafts.current.delete(clip.id);else drafts.current.set(clip.id,{base,text:value});changed();scheduleIdle();}}
            onCompositionStart={()=>{composing.current=true;cancelIdle();}}
            onCompositionEnd={()=>{composing.current=false;scheduleIdle();}}
            onBlur={event=>{if(stillComposing(event))return;void flush();}}
            onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();void flush();}}}/>
          {conflict&&<div role="alert">保存済みの本文：{clip.content.data.text}<button onClick={()=>{drafts.current.delete(clip.id);changed();setError(null);}}>現在の本文を使う</button><button onClick={()=>{drafts.current.set(clip.id,{base:clip.content.data.text,text});changed();setError(null);}}>入力した本文を使う</button></div>}
          {(()=>{
            const chips=captionWordChips(props.state.document,clip);
            if(!chips.length)return <p className="native-subtle">この字幕には語のタイミングがありません。本文の編集と行の削除はできます。</p>;
            return <div className="native-caption-chips">{chips.map((chip,index)=>
              <button key={index} type="button" className={`native-caption-chip ${chip.cut?'is-cut':''}`} disabled={disabled}
                aria-label={`${chip.text} ${captionTime(props.state.document,chip.startFrame)}へ移動`}
                title={chip.cut?'カット済みの語':'押すとこの語の先頭へ移動'}
                onClick={event=>{event.stopPropagation();props.onSelect(clip.id,chip.startFrame);}}>{chip.text}</button>)}</div>;
          })()}
          <p className="native-subtle">本文は入力を止めると自動で反映されます。続けて直した字幕はまとめて 1 回の取り消しで戻せます。</p>
          <div className="native-caption-row-actions">
            <button disabled={disabled||props.frame<=clip.startFrame||props.frame>=clipEnd(clip)}
              title={props.frame<=clip.startFrame||props.frame>=clipEnd(clip)?'この字幕の途中へ再生位置を移動してください':'再生位置で 2 つに分けます'}
              onClick={()=>void action(clip.id,'split')}>再生位置で分割</button>
            <button disabled={disabled||!nextCaption(props.state.document,clip.id)}
              title={nextCaption(props.state.document,clip.id)?'次の字幕と 1 つにまとめます':'同じトラックに結合できる次の字幕がありません'}
              onClick={()=>void action(clip.id,'merge')}>次と結合</button>
            <button disabled={disabled} onClick={()=>void action(clip.id,decoration?'delete':'cut')}>{decoration?'テロップを削除':'この発話をカット'}</button>
            <button disabled={disabled} onClick={()=>{void flush().then(ok=>{if(ok)props.onStyle(clip.id);});}}>見た目を調整</button>
          </div>
        </>}
      </article>;
    })}
    {[...drafts.current].filter(([id])=>!clips.some(c=>c.id===id)).map(([id,draft])=><article key={id}><p>削除された字幕の入力</p><textarea aria-label="未反映の字幕本文" readOnly value={draft.text}/><button onClick={()=>{drafts.current.delete(id);changed();setError(null);}}>入力を破棄</button></article>)}
    {!clips.length&&<p className="native-subtle">字幕はまだありません。</p>}
  </section>;
});

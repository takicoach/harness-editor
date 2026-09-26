import {useLayoutEffect,useRef,useState,type RefObject} from 'react';
import type {SequenceDocument} from '../../core/sequence/model';
import {clipEnd} from '../../core/sequence/model';
import {ceilTime,divideTime,multiplyTime,rational,timeNumber} from '../../core/sequence/time';
import {cutSourceOwners,cutSourceReview,sourceToCutLocal} from './cutSourceReview';
import type {NativePreviewHandle} from './NativePreview';

interface Context {projectId:string;sessionId?:string;document:SequenceDocument|null;mode:string;activeCutId:string|null}
interface Source extends Context {entryId:string;clipId:string;preview:SequenceDocument;initialFrame:number;serial:number}
interface Options extends Context {
  player:RefObject<NativePreviewHandle|null>;
  prepare():Promise<boolean>;
  readDocument?():SequenceDocument|null;
  onError(message:string):void;
  onProgramFrame(frame:number):void;
}
const sameLocation=(a:Context,b:Context)=>a.projectId===b.projectId&&a.sessionId===b.sessionId&&a.document?.id===b.document?.id&&a.mode===b.mode&&a.activeCutId===b.activeCutId;
const same=(a:Context,b:Context)=>sameLocation(a,b)&&a.document?.revision===b.document?.revision;

/** Source playback is a disposable monitor projection. It never replaces the editing document or clock. */
export function useCutSourcePreview(options:Options){
  const [source,setSource]=useState<Source|null>(null),[sourceFrame,setSourceFrame]=useState(0);
  const [choice,setChoice]=useState<{document:SequenceDocument;entryId:string;clipId:string}|null>(null);
  const [pending,setPending]=useState(false);
  const latest=useRef(options);latest.current=options;
  const serial=useRef(0),opening=useRef(0),openingLocked=useRef(false),mountedSource=useRef<Source|null>(null),displayedSource=useRef<Source|null>(null);
  useLayoutEffect(()=>()=>{opening.current++;serial.current++;mountedSource.current=null;},[options.projectId,options.sessionId,options.document?.id,options.mode,options.activeCutId]);
  useLayoutEffect(()=>{if(source&&!same(source,options))setSource(null);},[options.projectId,options.sessionId,options.document?.id,options.document?.revision,options.mode,options.activeCutId]);
  const active=source&&source.serial===serial.current&&same(source,options)&&options.mode==='finish'?source:null;
  mountedSource.current=active;displayedSource.current=active;
  const owners=options.document&&options.activeCutId?cutSourceOwners(options.document,options.activeCutId):[];
  const videos=owners.filter(clip=>clip.content.kind==='video');
  const defaultOwner=videos.length===1?videos[0]:videos.length===0&&owners.length===1?owners[0]:undefined;
  const clipId=choice?.document===options.document&&choice.entryId===options.activeCutId&&owners.some(clip=>clip.id===choice.clipId)?choice.clipId:defaultOwner?.id??'';
  const stop=(cancelOpening=true)=>{if(cancelOpening)opening.current++;serial.current++;latest.current.player.current?.pause();mountedSource.current=null;setSource(null);};
  const choose=(id:string)=>{stop();if(options.document&&options.activeCutId)setChoice({document:options.document,entryId:options.activeCutId,clipId:id});};
  const open=async()=>{
    if(openingLocked.current||!options.document||!options.activeCutId||!clipId)return;
    const owner=options,request=++opening.current;
    openingLocked.current=true;setPending(true);
    try{
      if(!await options.prepare()||request!==opening.current||!sameLocation(owner,latest.current))return;
      const document=latest.current.readDocument?latest.current.readDocument():latest.current.document;
      if(!document||document.id!==owner.document!.id)return;
      const clip=cutSourceOwners(document,owner.activeCutId!).find(clip=>clip.id===clipId);
      if(!clip)throw new Error('確認する使用箇所が変わりました。選び直してください。');
      const preview=cutSourceReview(document,owner.activeCutId!,clipId);
      if(clip.content.kind!=='video'&&clip.content.kind!=='audio')return;
      const initialFrame=Math.max(0,Math.min(preview.sequenceEndFrame-1,ceilTime(multiplyTime(clip.content.sourceIn,preview.fps))));
      options.player.current?.pause();
      const next={...latest.current,document,entryId:owner.activeCutId!,clipId,preview,initialFrame,serial:++serial.current};
      mountedSource.current=next;setSourceFrame(initialFrame);setSource(next);
    }catch(error){if(request===opening.current&&sameLocation(owner,latest.current))options.onError(error instanceof Error?error.message:String(error));}
    finally{openingLocked.current=false;setPending(false);}
  };
  const seekProgram=(frame:number)=>{
    opening.current++;
    if(displayedSource.current||mountedSource.current){stop();latest.current.onProgramFrame(frame);}
    else void latest.current.player.current?.seek(frame);
  };
  let marker:{entryId:string;localFrame:number}|null|undefined=undefined;
  if(active){
    marker=null;
    const clip=owners.find(clip=>clip.id===active.clipId);
    if(clip){
      const local=timeNumber(sourceToCutLocal(clip,divideTime(rational(sourceFrame),active.preview.fps),options.document!.fps));
      if(local>=clip.startFrame&&local<clipEnd(clip))marker={entryId:active.entryId,localFrame:local};
    }
  }
  const onFrame=(frame:number)=>{
    // Ignore a late render callback from the monitor that was just replaced.
    if(!same(options,latest.current))return;
    if(active){if(mountedSource.current===active)setSourceFrame(frame);}
    else if(!mountedSource.current)options.onProgramFrame(frame);
  };
  return {active,owners,clipId,pending,choose,open,stop,seekProgram,onFrame,marker};
}

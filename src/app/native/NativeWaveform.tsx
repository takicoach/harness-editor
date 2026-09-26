import {reportEditorError} from './notificationHistory';
import {acquireWaveform} from './waveformCache';
import {useEffect,useRef,useState} from 'react';
import type {SequenceClip} from '../../core/sequence/model';
import type {ScenePlan} from '../../core/sequence/scenePlan';
import type {WaveformResponse} from '../../server/sequence/waveform';
import {useThemeValue} from '../layout/useThemeValue';
import {TaskProgress} from '../components/TaskProgress';
import type {WaveformViewport} from './waveformViewport';
import {waveformPresentation,waveformRequestKey as requestKey,waveformGainAt} from './waveformPresentation';

interface Props {
  projectId:string;clip:SequenceClip;plan:ScenePlan;viewport:WaveformViewport;
  height:number;displayGain:number;sourceOffsetFrames:number;displayDuration:number;displayStartFrame?:number;
}

/** A bounded source envelope; audio mixing continues to use the shared mixer. */
export function NativeWaveform({projectId,clip,plan,viewport,height,displayGain,sourceOffsetFrames,displayDuration,displayStartFrame=clip.startFrame+sourceOffsetFrames}:Props){
  const canvas=useRef<HTMLCanvasElement>(null),theme=useThemeValue();
  const [loaded,setLoaded]=useState<{key:string;data:WaveformResponse}|null>(null),[failed,setFailed]=useState<{key:string;message:string}|null>(null),[retry,setRetry]=useState(0);
  const presentation=waveformPresentation(clip,plan.document.fps,viewport,sourceOffsetFrames,displayStartFrame,displayDuration);
  const request=presentation.ok?presentation.request:null;
  const fingerprint=request?plan.document.assets.find(asset=>asset.id===request.assetId)?.fingerprint:null;
  const key=JSON.stringify([projectId,fingerprint,request?requestKey(request):null]),data=request&&loaded?.key===key?loaded.data:null;
  const error=!presentation.ok?presentation.error:failed?.key===key?failed.message:null;
  useEffect(()=>{
    if(!request)return;
    const controller=new AbortController();let shared:ReturnType<typeof acquireWaveform>|undefined;
    // Rapid scrolling changes the requested interval; only the settled visible
    // interval starts preparation, and every obsolete request is cancelled.
    const timer=setTimeout(()=>{
      const params=new URLSearchParams({id:projectId,asset:request.assetId,stream:String(request.streamIndex),rateNum:String(request.rate.num),rateDen:String(request.rate.den),
        sourceInNum:String(request.sourceIn.num),sourceInDen:String(request.sourceIn.den),fpsNum:String(request.fps.num),fpsDen:String(request.fps.den),
        startFrame:String(request.startFrame),frameCount:String(request.frameCount),clipFrames:String(request.clipFrames),bins:String(request.bins),loop:request.loop?'1':'0'});
      shared=acquireWaveform(key,signal=>fetch(`/api/sequence/waveform?${params}`,{signal}).then(async response=>{
        const body=await response.json();if(!response.ok)throw new Error(body.error??'波形を準備できませんでした');
        const value=body as WaveformResponse;
        if(value.version!==1||value.precision!=='prepared-pcm-sample-floor'||!value.request||requestKey(value.request)!==requestKey(request)
          ||!Array.isArray(value.bins)||value.bins.length!==request.bins||value.bins.some(bin=>![bin.peak,bin.rms,bin.samples].every(Number.isFinite)||bin.peak<0||bin.rms<0||!Number.isSafeInteger(bin.samples)||bin.samples<0))throw new Error('波形データが要求した範囲と一致しません');
        return value;
      }));
      void shared.promise.then(value=>{if(!controller.signal.aborted){setLoaded({key,data:value});setFailed(null);}}).catch(error=>{if(!controller.signal.aborted){const message=error instanceof Error?error.message:'波形を準備できませんでした';setFailed({key,message});reportEditorError(projectId,'波形',message);}});
    },120);
    return()=>{clearTimeout(timer);controller.abort();shared?.release();};
  },[key,retry]);
  useEffect(()=>{
    const target=canvas.current;if(!target)return;
    target.width=viewport.bins;target.height=Math.max(1,Math.min(192,Math.round(height*(window.devicePixelRatio||1))));
    const context=target.getContext('2d');if(!context)return;
    context.clearRect(0,0,target.width,target.height);if(!data||!presentation.ok)return;
    const css=getComputedStyle(document.documentElement),mid=target.height/2;
    for(const field of ['peak','rms'] as const){
      context.fillStyle=css.getPropertyValue(`--wave-${field}`).trim()||(field==='peak'?'rgba(96,118,150,.30)':'rgba(96,118,150,.55)');
      for(let i=0;i<data.bins.length;i++){
        const localFrame=viewport.startFrame+(i+.5)*viewport.frameCount/viewport.bins;
        const amplitude=Math.min(1,data.bins[i]![field]*waveformGainAt(plan,presentation.clip,localFrame)*displayGain),bar=amplitude*target.height;
        context.fillRect(i,mid-bar/2,1,bar);
      }
    }
  },[data,plan,clip,viewport.startFrame,viewport.frameCount,viewport.bins,height,displayGain,sourceOffsetFrames,displayStartFrame,displayDuration,theme]);
  return <div className="native-waveform" style={{left:viewport.left,width:viewport.width,height}} title="素材の波形（音量の目安）">
    <canvas ref={canvas} style={{width:'100%',height:'100%'}} aria-label={`${clip.name}の音声波形`} role="img" data-native-waveform={data?'ready':error?'error':'loading'} data-waveform-start={viewport.startFrame} data-waveform-frames={viewport.frameCount}/>
    {!presentation.ok?<span className="native-waveform-status" role="status" title={error??undefined}>この範囲の波形を表示できません</span>:error?<button className="native-waveform-status" aria-label={`${clip.name}の波形を再読み込み`} title={error} onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();setFailed(null);setRetry(value=>value+1);}}>波形を再試行</button>:!data&&<span className="native-waveform-status"><TaskProgress compact label="波形を準備中…"/></span>}
  </div>;
}

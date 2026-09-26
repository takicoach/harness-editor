import {useCallback,useEffect,useRef,useState} from 'react';
import {normalizedVolumeFromSamples} from '../audio/loudness';

export type AssetAuditionKind='bgm'|'se';
export interface AssetAudition {playingId:string|null;toggle(assetId:string,url:string,kind?:AssetAuditionKind):void;stop():void}
/** これより長い素材は解析せず音量 1 で鳴らす（試聴のために全体をデコードしない）。 */
const ANALYZE_LIMIT_BYTES=24*1024*1024;

/** 素材行の試聴。同時に鳴るのは 1 つだけ。音量は legacy と同じ正規化を使う。 */
export function useAssetAudition():AssetAudition{
  const audio=useRef<HTMLAudioElement|null>(null);
  const [playingId,setPlayingId]=useState<string|null>(null);
  const volumes=useRef(new Map<string,number>());
  const stop=useCallback(()=>{audio.current?.pause();audio.current=null;setPlayingId(null);},[]);
  useEffect(()=>()=>{audio.current?.pause();audio.current=null;},[]);
  // M-d: 素材の実体（BGM か SE/その他）で正規化基準を出し分ける。呼び出し元（一覧の file パス）から
  // 判別できない場合は 'se' を既定にする — BGM 用の目標ラウドネスは SE より低いため、誤って
  // 'bgm' 扱いにすると素性不明の素材が実際より大きく試聴されてしまう事故のほうが起きやすい。
  const toggle=useCallback((assetId:string,url:string,kind:AssetAuditionKind='se')=>{
    if(playingId===assetId){stop();return;}
    stop();
    const element=new Audio(url);
    element.volume=volumes.current.get(assetId)??1;
    element.onended=()=>{if(audio.current===element)stop();};
    element.onerror=()=>{if(audio.current===element)stop();};
    audio.current=element;setPlayingId(assetId);
    void element.play().catch(()=>{if(audio.current===element)stop();});
    if(!volumes.current.has(assetId))void measure(url,kind).then(value=>{
      if(value===null)return;
      volumes.current.set(assetId,value);
      if(audio.current===element)element.volume=value;
    }).catch(()=>undefined);
  },[playingId,stop]);
  return {playingId,toggle,stop};
}

/** 音量解析は試聴の副次機能。fetch/AudioContext が使えない環境（テスト等）では静かに諦め、既定音量のまま鳴らす。 */
async function measure(url:string,kind:AssetAuditionKind):Promise<number|null>{
  if(typeof fetch!=='function'||typeof AudioContext!=='function')return null;
  const response=await fetch(url);if(!response.ok)return null;
  const length=Number(response.headers.get('content-length')??0);
  // M-c: 上限超過で解析を諦める時は、読み切らない response の body を明示的に閉じる
  // （放置すると環境によっては接続が張られたままになる）。
  if(length>ANALYZE_LIMIT_BYTES){void response.body?.cancel();return null;}
  const context=new AudioContext();
  try{
    const buffer=await context.decodeAudioData(await response.arrayBuffer());
    return normalizedVolumeFromSamples(buffer.getChannelData(0),kind);
  }catch{return null;}
  finally{void context.close();}
}

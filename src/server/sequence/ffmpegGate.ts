import {setTimeout as sleep} from 'node:timers/promises';

/** 設計 §2-1: コマ絵・音声・波形の FFmpeg/FFprobe を1か所で数える（取り込みの調査は数えない）。順位は「プレビュー・音声 ＞ 波形 ＞ コマ絵」。 */
export type FfmpegPriority='preview'|'audio'|'waveform'|'filmstrip';
export const FFMPEG_PRIORITY_RANK:Readonly<Record<FfmpegPriority,number>>={preview:0,audio:0,waveform:1,filmstrip:2};
/** 共有の準備に急ぐ呼び手が合流したら順位を上げられるよう、順位は書き換えられる箱で持つ。 */
export interface FfmpegLane {rank:number}
export const ffmpegLane=(priority:FfmpegPriority):FfmpegLane=>({rank:FFMPEG_PRIORITY_RANK[priority]});
export function raiseLane(lane:FfmpegLane,priority:FfmpegPriority):void{lane.rank=Math.min(lane.rank,FFMPEG_PRIORITY_RANK[priority]);}
/** 今の順位の呼び名（準備の中で別の共有の準備を待つ時に、同じ順位で合流するため）。 */
export function lanePriority(lane:FfmpegLane):FfmpegPriority{return lane.rank<=FFMPEG_PRIORITY_RANK.audio?'audio':lane.rank<=FFMPEG_PRIORITY_RANK.waveform?'waveform':'filmstrip';}
export class FfmpegBusyError extends Error{constructor(){super('処理が混み合っています。少し待ってからもう一度お試しください');this.name='FfmpegBusyError';}}
interface Waiting {lane:FfmpegLane;order:number;start():void;fail(error:unknown):void}
export class FfmpegGate {
  private active=0;private lowActive=0;private next=0;private readonly waiting:Waiting[]=[];
  /** slots: 全体の同時数。lowSlots: コマ絵が同時に使える数（残りは急ぐ処理のために空ける）。maxWaiting: 待ち行列の上限。 */
  constructor(readonly slots:number,readonly lowSlots:number,readonly maxWaiting:number){}
  get stats(){return {active:this.active,waiting:this.waiting.length};}
  acquire(lane:FfmpegLane,signal?:AbortSignal):Promise<()=>void>{
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const abort=()=>{const index=this.waiting.indexOf(entry);if(index>=0){this.waiting.splice(index,1);entry.fail(signal!.reason??new Error('処理を中止しました'));}};
      const entry:Waiting={lane,order:this.next++,
        start:()=>{signal?.removeEventListener('abort',abort);const low=lane.rank>=FFMPEG_PRIORITY_RANK.filmstrip;this.active++;if(low)this.lowActive++;
          let released=false;resolve(()=>{if(released)return;released=true;this.active--;if(low)this.lowActive--;this.pump();});},
        fail:error=>{signal?.removeEventListener('abort',abort);reject(error);}};
      if(this.waiting.length>=this.maxWaiting){
        const worst=this.waiting.reduce<Waiting|undefined>((a,b)=>!a||b.lane.rank>a.lane.rank||b.lane.rank===a.lane.rank&&b.order>a.order?b:a,undefined);
        if(!worst||worst.lane.rank<=lane.rank){reject(new FfmpegBusyError());return;}
        this.waiting.splice(this.waiting.indexOf(worst),1);worst.fail(new FfmpegBusyError());
      }
      signal?.addEventListener('abort',abort,{once:true});this.waiting.push(entry);this.pump();
    });
  }
  private pump():void{
    while(this.active<this.slots){
      let best:Waiting|undefined;
      for(const entry of this.waiting){
        if(entry.lane.rank>=FFMPEG_PRIORITY_RANK.filmstrip&&this.lowActive>=this.lowSlots)continue;
        if(!best||entry.lane.rank<best.lane.rank||entry.lane.rank===best.lane.rank&&entry.order<best.order)best=entry;
      }
      if(!best)return;
      this.waiting.splice(this.waiting.indexOf(best),1);best.start();
    }
  }
}
/** 確定値は事前の測定で決めた。 */
export const FFMPEG_SLOTS=3,FFMPEG_LOW_SLOTS=2,FFMPEG_MAX_WAITING=64;
export const ffmpegGate=new FfmpegGate(FFMPEG_SLOTS,FFMPEG_LOW_SLOTS,FFMPEG_MAX_WAITING);
/** 停止の再現試験（scripts/native-stall-audit.ts）専用。製品の起動（desktop/server.mjs・npm run edit）では設定しない。 */
const testDelayMs=()=>Number(process.env.HARNESS_TEST_FFMPEG_DELAY_MS??0);
export async function withFfmpegSlot<T>(lane:FfmpegLane,signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T>{
  const release=await ffmpegGate.acquire(lane,signal);
  try{const delay=testDelayMs();if(delay>0)await sleep(delay,undefined,{signal});return await work();}
  finally{release();}
}

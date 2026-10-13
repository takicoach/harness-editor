/** 設計 §2-2: 「準備中」の波形は準備の識別子ごとに1本だけ状態を問う。周期ごとに全識別子を1要求にまとめ、接続は1本しか使わない。 */
export const WAVEFORM_POLL_MS=400;
type Outcome='ready'|'missing';
interface Waiter {resolve(value:Outcome):void;reject(error:Error):void}
const pending=new Map<string,{projectId:string;waiters:Set<Waiter>}>();
// 応答待ちの間は次の周期を立てない（遅い応答＝接続が詰まっている最中に問い合わせを重ねない）。
let timer:ReturnType<typeof setTimeout>|undefined,polling=false;
function schedule(){if(timer===undefined&&!polling&&pending.size)timer=setTimeout(()=>{timer=undefined;void poll();},WAVEFORM_POLL_MS);}
async function poll(){
  polling=true;
  try{
    const byProject=new Map<string,string[]>();
    for(const [id,entry] of pending)byProject.set(entry.projectId,[...(byProject.get(entry.projectId)??[]),id]);
    await Promise.all([...byProject].map(async([projectId,ids])=>{
      for(let i=0;i<ids.length;i+=64){
        const chunk=ids.slice(i,i+64);
        try{
          const response=await fetch(`/api/sequence/waveform/status?${new URLSearchParams({id:projectId,preparation:chunk.join(',')})}`),body=await response.json();
          if(!response.ok)continue;
          for(const id of chunk){
            const status=body.preparations?.[id],entry=pending.get(id);if(!entry||!status||status.state==='preparing')continue;
            pending.delete(id);
            for(const waiter of entry.waiters){if(status.state==='failed')waiter.reject(new Error(String(status.error??'波形を準備できませんでした')));else waiter.resolve(status.state==='ready'?'ready':'missing');}
          }
        }catch{/* 次の周期で問い直す */}
      }
    }));
  }finally{polling=false;schedule();}
}
/** 混雑（503）のときに次の取り直しまで待つ。取り消されたらすぐ抜ける。 */
export function waitWaveformPollInterval(signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(wait);reject(signal.reason);},wait=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},WAVEFORM_POLL_MS);signal.addEventListener('abort',abort,{once:true});});
}
/** 'missing' はサーバが準備を覚えていない（再起動など）。呼び手は波形を取り直す（サーバが準備をやり直す）。 */
export function waitForWaveformPreparation(projectId:string,preparationId:string,signal:AbortSignal):Promise<Outcome>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const entry=pending.get(preparationId)??{projectId,waiters:new Set<Waiter>()};pending.set(preparationId,entry);
    const waiter:Waiter={resolve:value=>{signal.removeEventListener('abort',abort);resolve(value);},reject:error=>{signal.removeEventListener('abort',abort);reject(error);}};
    const abort=()=>{entry.waiters.delete(waiter);if(!entry.waiters.size&&pending.get(preparationId)===entry)pending.delete(preparationId);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});entry.waiters.add(waiter);schedule();
  });
}

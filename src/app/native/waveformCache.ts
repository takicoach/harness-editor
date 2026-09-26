import type {WaveformResponse} from '../../server/sequence/waveform';
interface Entry {controller:AbortController;promise:Promise<WaveformResponse>;users:number;data?:WaveformResponse;lastUsed:number}
const cache=new Map<string,Entry>();
const MAX_ENTRIES=128,MAX_BINS=256*1024,MAX_AGE_MS=60_000;
function trim(){
  let bins=[...cache.values()].reduce((n,e)=>n+(e.data?.bins.length??0),0);
  for(const [key,entry] of cache){
    if(entry.users||!entry.data)continue;
    if(cache.size<=MAX_ENTRIES&&bins<=MAX_BINS&&Date.now()-entry.lastUsed<MAX_AGE_MS)continue;
    bins-=entry.data.bins.length;cache.delete(key);
  }
}
/** Abort a shared request only after its last consumer leaves. Rejections never poison retries. */
export function acquireWaveform(key:string,fetcher:(signal:AbortSignal)=>Promise<WaveformResponse>):{promise:Promise<WaveformResponse>;release():void}{
  trim();let entry=cache.get(key);
  if(!entry){
    const controller=new AbortController();
    entry={controller,users:0,lastUsed:Date.now(),promise:undefined!};
    const own=entry;
    own.promise=fetcher(controller.signal).then(data=>{own.data=data;trim();return data;}).catch(error=>{if(cache.get(key)===own)cache.delete(key);throw error;});
    cache.set(key,own);
  }
  const own=entry;own.users++;own.lastUsed=Date.now();cache.delete(key);cache.set(key,own);
  let released=false;
  return {promise:own.promise,release(){if(released)return;released=true;own.users--;
    if(!own.users&&!own.data){own.controller.abort();if(cache.get(key)===own)cache.delete(key);}trim();}};
}

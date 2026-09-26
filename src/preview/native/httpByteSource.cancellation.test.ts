import {createServer,type ServerResponse} from 'node:http';
import {EventEmitter,once} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
import {DECODE_PROGRESS_TIMEOUT_MS,httpByteSource,Mp4FrameSource,type ByteSource} from './mp4FrameSource';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0))await cleanup();});
function readOnlySource(bytes:ByteSource){
  const Constructor=Mp4FrameSource as unknown as new(bytes:ByteSource,config:VideoDecoderConfig,samples:unknown[],budget:number)=>Mp4FrameSource;
  return new Constructor(bytes,{codec:'unused-during-read'},[{timestamp:0,identity:{sample:0,pts:{num:0,den:1},duration:{num:1,den:30}},sample:{is_sync:true,offset:1,size:11}}],64);
}
async function fixture(){
  const pending=new Map<string,ServerResponse>(),events=new EventEmitter();
  const server=createServer((req,res)=>{
    const range=req.headers.range!,match=/^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start=Number(match[1]),end=Number(match[2]);
    res.writeHead(206,{'content-range':`${range.replace('=',' ')}/36`,'content-length':end-start+1});
    if(range==='bytes=0-0'){res.end(Buffer.alloc(1));return;}
    pending.set(range,res);res.on('close',()=>{if(pending.get(range)===res)pending.delete(range);});
    res.write(Buffer.alloc(1));events.emit(range,res);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test address');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {url:`http://127.0.0.1:${address.port}`,pending,async response(range:string):Promise<ServerResponse>{return pending.get(range)??(await once(events,range))[0];}};
}
it('cancels only the requested range, leaves the renderer and another read alive, and permits retry',async()=>{
  const server=await fixture(),parent=new AbortController(),bytes=await httpByteSource(server.url,parent.signal),first=new AbortController();
  const a=bytes.read(1,12,first.signal),aRejected=expect(a).rejects.toMatchObject({name:'AbortError'});
  const b=bytes.read(12,24);
  const [ra,rb]=await Promise.all([server.response('bytes=1-11'),server.response('bytes=12-23')]);
  const closed=once(ra,'close');first.abort();await aRejected;await closed;
  expect(parent.signal.aborted).toBe(false);expect(rb.destroyed).toBe(false);
  rb.end(Buffer.alloc(11));expect((await b).byteLength).toBe(12);
  const retry=bytes.read(1,12);(await server.response('bytes=1-11')).end(Buffer.alloc(10));
  expect((await retry).byteLength).toBe(11);
});
it('still aborts all active reads when their renderer is disposed',async()=>{
  const server=await fixture(),parent=new AbortController(),bytes=await httpByteSource(server.url,parent.signal);
  const reads=[bytes.read(1,12),bytes.read(12,24)],rejected=reads.map(work=>expect(work).rejects.toMatchObject({name:'AbortError'}));
  const responses=await Promise.all([server.response('bytes=1-11'),server.response('bytes=12-23')]);
  const closed=responses.map(response=>once(response,'close'));parent.abort();
  await Promise.all([...rejected,...closed]);expect(server.pending.size).toBe(0);
});
it('aborts a disposed decoder read without aborting the renderer or future independent reads',async()=>{
  const server=await fixture(),parent=new AbortController(),bytes=await httpByteSource(server.url,parent.signal),source=readOnlySource(bytes);
  try{
    const work=source.acquire({num:0,den:1}),rejected=expect(work).rejects.toThrow('閉じ');
    const response=await server.response('bytes=1-11'),closed=once(response,'close');
    source.dispose();await rejected;await closed;
    expect(server.pending.size).toBe(0);expect(parent.signal.aborted).toBe(false);
    const independent=bytes.read(1,12);(await server.response('bytes=1-11')).end(Buffer.alloc(10));
    expect((await independent).byteLength).toBe(11);
  }finally{source.dispose();parent.abort();}
});
it('aborts the actual HTTP body after each decoder read timeout instead of accumulating abandoned retries',async()=>{
  const server=await fixture(),parent=new AbortController(),bytes=await httpByteSource(server.url,parent.signal);
  const source=readOnlySource(bytes);
  const deadlines:Array<()=>void>=[],schedule=setTimeout;
  vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:(...args:any[])=>void,delay?:number,...args:any[])=>{
    if(delay===DECODE_PROGRESS_TIMEOUT_MS)deadlines.push(()=>callback(...args));
    return schedule(callback,delay,...args);
  }) as typeof setTimeout);
  try{
    for(let attempt=0;attempt<2;attempt++){
      const work=source.acquire({num:0,den:1}),rejected=expect(work).rejects.toThrow('タイムアウト');
      const response=await server.response('bytes=1-11'),closed=once(response,'close');
      expect(deadlines).toHaveLength(1);deadlines.shift()!();await rejected;await closed;
      expect(server.pending.size).toBe(0);expect(parent.signal.aborted).toBe(false);
    }
    const retry=bytes.read(1,12);(await server.response('bytes=1-11')).end(Buffer.alloc(10));
    expect((await retry).byteLength).toBe(11);
  }finally{source.dispose();parent.abort();}
});

/**
 * OSS 利用者報告（2026-09-30）: 「映像の復号がタイムアウトしました」は読み込み・復号待ち・
 * 完了待ちのどこで止まっても同じ文言で、元の動画と軽量版のどちらを読んでいたかも分からず、
 * 報告から原因を切り分けられなかった。段階と読込元を文言に出す。
 */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DECODE_PROGRESS_TIMEOUT_MS,Mp4FrameSource,httpByteSource,type ByteSource} from './mp4FrameSource';
import {videoOnlyMp4Bytes} from './videoOnlyMp4Bytes';
import {rational as r} from '../../core/sequence/time';

type Mode='stalled'|'flush-stalled';
let mode:Mode='stalled';
const sources:Mp4FrameSource[]=[];
class FakeDecoder extends EventTarget {
  state='unconfigured';decodeQueueSize=0;
  constructor(readonly callbacks:VideoDecoderInit){super();}
  configure(){this.state='configured';}
  decode(){
    this.decodeQueueSize++;
    if(mode==='stalled')return;
    // 出力を溜めたまま（並べ替え待ち）受け付けだけ進め、完了待ち（flush）で止まる復号器。
    queueMicrotask(()=>{this.decodeQueueSize--;this.dispatchEvent(new Event('dequeue'));});
  }
  flush(){return new Promise<void>(()=>{});}
  close(){this.state='closed';}
}
const microtasks=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function source(bytes:Partial<ByteSource>={},count=3){
  const samples=Array.from({length:count},(_,i)=>({timestamp:Math.round(i/30*1e6),identity:{sample:i,pts:r(i,30),duration:r(1,30)},sample:{is_sync:i===0,offset:i*4,size:4,duration:1,timescale:30}}));
  const Constructor=Mp4FrameSource as unknown as new(bytes:ByteSource,config:VideoDecoderConfig,samples:unknown[],budget:number)=>Mp4FrameSource;
  const value=new Constructor({size:count*4,read:async(start,end)=>new ArrayBuffer(end-start),...bytes},{codec:'avc1.42001e'},samples,32);
  sources.push(value);return value;
}
async function timeoutMessage(value:Mp4FrameSource):Promise<string>{
  const work=value.acquire(r(0)).then(()=>'',(error:Error)=>error.message);
  await microtasks();await vi.advanceTimersByTimeAsync(DECODE_PROGRESS_TIMEOUT_MS);
  return work;
}
beforeEach(()=>{
  vi.useFakeTimers();mode='stalled';
  vi.stubGlobal('VideoDecoder',FakeDecoder);
  vi.stubGlobal('EncodedVideoChunk',class {constructor(init:EncodedVideoChunkInit){Object.assign(this,init);}});
});
afterEach(()=>{for(const value of sources.splice(0))value.dispose();vi.useRealTimers();vi.unstubAllGlobals();});

it('読み込みで止まったら「読み込み」と読込元（元の動画）を出す',async()=>{
  const message=await timeoutMessage(source({origin:'original',read:()=>new Promise(()=>{})}));
  expect(message).toContain('映像の読み込みがタイムアウトしました');
  expect(message).toContain('元の動画');
});
it('復号器が進まなければ「復号」と読込元（軽量版）を出す',async()=>{
  const message=await timeoutMessage(source({origin:'proxy'}));
  expect(message).toContain('映像の復号がタイムアウトしました');
  expect(message).toContain('軽量版');
  expect(message).not.toContain('読み込み');
});
it('完了待ち（flush）で止まれば「完了待ち」と出す',async()=>{
  mode='flush-stalled';
  const message=await timeoutMessage(source({origin:'original'}));
  expect(message).toContain('映像の復号の完了待ちがタイムアウトしました');
});
it('読込元が分からない配信（旧サーバー・書き出し）では括弧書きを付けない',async()=>{
  const message=await timeoutMessage(source());
  expect(message).toBe('映像の復号がタイムアウトしました。再試行してください');
});

it('プレビュー配信の読込元ヘッダーを読み、映像専用の読み口にも引き継ぐ',async()=>{
  vi.useRealTimers();
  const fetchMock=vi.fn(async()=>new Response(new Uint8Array(1),{status:206,headers:{'content-range':'bytes 0-0/16','x-harness-preview-source':'proxy'}}));
  vi.stubGlobal('fetch',fetchMock);
  const bytes=await httpByteSource('/api/sequence/asset?id=p&asset=a&preview=1');
  expect(bytes.origin).toBe('proxy');
  // moov が無い小さな入力は videoOnlyMp4Bytes が拒否するため、読み口の受け渡しだけを確かめる。
  const passthrough:ByteSource={size:16,origin:'original',read:async()=>{const view=new DataView(new ArrayBuffer(16));view.setUint32(0,16);view.setUint32(4,0x6d6f6f76);return view.buffer;}};
  expect((await videoOnlyMp4Bytes(passthrough).catch(()=>passthrough)).origin).toBe('original');
});

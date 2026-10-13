// 保存済みのコマ絵で答える時も原素材を確かめる（Codex 差分レビュー P2・2026-10-03）。確かめた記憶で全体読みは増やさない（設計 §2-3）。
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {copyFile,mkdtemp,realpath,rename,rm,stat,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** 原素材から読まれたバイト数（パスごと）と、全体読み（sharedFileDigest）の呼び出し。 */
const reads=vi.hoisted(()=>({bytes:new Map<string,number>(),digests:[] as string[]}));
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{const handle=await actual.open(...args),read=handle.read.bind(handle) as unknown as (...x:unknown[])=>Promise<{bytesRead:number}>,key=String(args[0]);
    Object.assign(handle,{read:async(...readArgs:unknown[])=>{const result=await read(...readArgs);reads.bytes.set(key,(reads.bytes.get(key)??0)+result.bytesRead);return result;}});return handle;}};});
vi.mock('./sharedDigest',async load=>{const actual=await load<typeof import('./sharedDigest')>();
  return {...actual,sharedFileDigest:(path:string,identity:string,signal?:AbortSignal)=>{reads.digests.push(path);return actual.sharedFileDigest(path,identity,signal);}};});
import type {SequenceAsset} from '../../core/sequence/model';
import {rational as r,type Rational} from '../../core/sequence/time';
import {createSequenceProject} from './create';
import {SequenceStore} from './store';
import {frameExtractions,prepareSequenceFrames,type FrameRequest} from './frameImages';
import {makeFrameNumberVideos,readFrameNumber,type FrameNumberVideos} from './__fixtures__/frameNumberVideos';

let media:string,root:string,videos:FrameNumberVideos;
/** 取り込み（案件内へ複製）と参照（外付けの元の場所を指す）。source は全体読みが開く実パス。 */
const kinds:Record<'managed'|'reference',{directory:string;asset:SequenceAsset;source:string;size:number}>={} as never;
beforeAll(async()=>{
  media=await mkdtemp(join(await realpath(tmpdir()),'harness-frames-source-media-'));root=await mkdtemp(join(await realpath(tmpdir()),'harness-frames-source-'));videos=makeFrameNumberVideos(media);
  for(const kind of ['managed','reference'] as const){
    const original=join(media,`${kind}.mp4`);await copyFile(videos.cfr2997,original);
    const {id}=await createSequenceProject(root,{name:kind,videoName:`${kind}.mp4`,sourcePath:original,reference:kind==='reference'}),directory=join(root,id);
    const asset=new SequenceStore(directory).load()!.document.assets.find(a=>a.streams.some(s=>s.kind==='video'))!;
    const source=kind==='managed'?await realpath(join(directory,asset.file)):original;
    kinds[kind]={directory,asset,source,size:(await stat(source)).size};
  }
},60000);
afterAll(async()=>{await rm(media,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
beforeEach(()=>{reads.bytes.clear();reads.digests.length=0;});
const request=(asset:SequenceAsset,times:Rational[]):FrameRequest=>({assetId:asset.id,streamIndex:0,height:72,times:times.map(time=>({key:`${time.num}/${time.den}`,time}))});
const numbers=(result:Awaited<ReturnType<typeof prepareSequenceFrames>>)=>result.frames.map(f=>readFrameNumber(Buffer.from(f.data.slice(f.data.indexOf(',')+1),'base64')));

describe.each(['managed','reference'] as const)('%s source',kind=>{
  it('answers cached frames with no whole-file read while the source is unchanged, and reads it once per request (not per frame) when the check is stale',async()=>{
    const {directory,asset,source,size}=kinds[kind];
    expect(numbers(await prepareSequenceFrames(directory,asset,request(asset,[r(1),r(2)])))).toEqual([29,59]);   // 索引とコマ絵を保存し、照合を記憶する
    reads.bytes.clear();reads.digests.length=0;const before=frameExtractions.count;
    expect(numbers(await prepareSequenceFrames(directory,asset,request(asset,[r(1),r(2)])))).toEqual([29,59]);
    expect(frameExtractions.count).toBe(before);expect(reads.digests).toEqual([]);expect(reads.bytes.get(source)??0).toBe(0);
    // 同じ中身で識別情報だけ変わった（記憶が外れる）: 新しいコマ3つを切り出しても、全体読みはこの要求で1回
    const later=new Date(Date.now()+5000);await utimes(source,later,later);
    expect(numbers(await prepareSequenceFrames(directory,asset,request(asset,[r(3),r(4),r(5)])))).toEqual([89,119,149]);
    expect(frameExtractions.count-before).toBe(3);expect(reads.digests).toEqual([source]);expect(reads.bytes.get(source)).toBe(size);
  },60000);
  it('refuses cached frames once the source is gone (moved away, drive unplugged), and serves them again when it is back',async()=>{
    const {directory,asset,source}=kinds[kind],cached=request(asset,[r(1)]);
    expect(numbers(await prepareSequenceFrames(directory,asset,cached))).toEqual([29]);
    const away=`${source}.away`;await rename(source,away);
    try{await expect(prepareSequenceFrames(directory,asset,cached)).rejects.toThrow(/ENOENT|見つかりません/);}
    finally{await rename(away,source);}
    expect(numbers(await prepareSequenceFrames(directory,asset,cached))).toEqual([29]);
  },60000);
  it('refuses cached frames once the source is replaced by other content',async()=>{
    const {directory,asset,source}=kinds[kind],cached=request(asset,[r(1)]);
    expect(numbers(await prepareSequenceFrames(directory,asset,cached))).toEqual([29]);
    const kept=`${source}.kept`;await rename(source,kept);await copyFile(videos.vfr,source);
    try{await expect(prepareSequenceFrames(directory,asset,cached)).rejects.toThrow(/変更|一致しません/);}
    finally{await rm(source,{force:true});await rename(kept,source);}
    expect(numbers(await prepareSequenceFrames(directory,asset,cached))).toEqual([29]);
  },60000);
});

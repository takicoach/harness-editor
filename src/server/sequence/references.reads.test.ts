// src/server/sequence/references.reads.test.ts
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {closeSync,copyFileSync,mkdirSync,mkdtempSync,openSync,realpathSync,renameSync,rmSync,statSync,writeFileSync,writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeVideoSamples,type VideoSamples} from './__fixtures__/videoSamples';

/** 参照先から読まれたバイト数（パスごと）。ffprobe は子プロセスなので数えない（部分読み）。 */
const reads=vi.hoisted(()=>({bytes:new Map<string,number>()}));
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{const handle=await actual.open(...args),read=handle.read.bind(handle) as unknown as (...x:unknown[])=>Promise<{bytesRead:number}>,key=String(args[0]);
    Object.assign(handle,{read:async(...readArgs:unknown[])=>{const result=await read(...readArgs);reads.bytes.set(key,(reads.bytes.get(key)??0)+result.bytesRead);return result;}});return handle;}};});
vi.mock('node:fs',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs')>();
  return {...actual,createReadStream:(...args:Parameters<typeof actual.createReadStream>)=>{const stream=actual.createReadStream(...args),key=String(args[0]);
    stream.on('data',chunk=>reads.bytes.set(key,(reads.bytes.get(key)??0)+chunk.length));return stream;}};});
/** 参照の調査で ffprobe が開いた実体（fd:）を受け取って動き出した時に、1回だけ走らせる操作。ran は実際に走ったことの記録（差し替えが効いた証拠）。 */
const probing=vi.hoisted(()=>({during:undefined as (()=>void)|undefined,ran:false}));
vi.mock('node:child_process',async importOriginal=>{const actual=await importOriginal<typeof import('node:child_process')>();
  return {...actual,spawn:(...args:Parameters<typeof actual.spawn>)=>{const child=actual.spawn(...args),during=probing.during;
    if(during&&/ffprobe/.test(String(args[0]))&&(args[1] as readonly string[]).includes('fd:')){probing.during=undefined;child.once('spawn',()=>{during();probing.ran=true;});}
    return child;}};});
import {registerSequenceReferenceDetailed,registeredSequenceReferences,openSequenceReference} from './references';

let samples:VideoSamples,root:string;
afterEach(()=>{probing.during=undefined;probing.ran=false;});
beforeAll(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'reference-reads-')));samples=makeVideoSamples(root);},30000);
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const project=()=>realpathSync(mkdtempSync(join(root,'project-')));

it('reads the referenced file in full exactly once (probe and hash share the opened file, the final check uses the verified cache)',async()=>{
  const source=join(root,'once.mp4');copyFileSync(samples.second60,source);reads.bytes.clear();
  const phases:string[]=[],{asset}=await registerSequenceReferenceDetailed(project(),source,'once.mp4',undefined,undefined,{onPhase:phase=>phases.push(phase),onProbed:()=>phases.push('probed')});
  expect(reads.bytes.get(realpathSync(source))).toBe(statSync(source).size);
  expect(phases).toEqual(['probing','probed','fingerprinting']);expect(asset.streams.find(s=>s.kind==='video')?.frameRate).toEqual({num:60,den:1});
});
it('refuses a file swapped while it is being checked and registers nothing',async()=>{
  const source=join(root,'swap.mp4'),other=join(root,'other.mp4'),dir=project();copyFileSync(samples.first,source);copyFileSync(samples.third25,other);
  await expect(registerSequenceReferenceDetailed(dir,source,'swap.mp4',undefined,undefined,{onPhase:phase=>{if(phase==='fingerprinting')renameSync(other,source);}})).rejects.toThrow('確認中に参照先が変更されました');
  expect(await registeredSequenceReferences(dir)).toEqual([]);
});
it('still re-checks an existing registration whose target was damaged',async()=>{
  const source=join(root,'kept.mp4'),dir=project();copyFileSync(samples.first,source);
  const {asset}=await registerSequenceReferenceDetailed(dir,source,'kept.mp4');
  writeFileSync(source,Buffer.alloc(statSync(source).size,1));
  await expect(openSequenceReference(dir,asset)).rejects.toThrow('参照素材の内容が保存時と一致しません');
});
/** 16 ビット・モノラル・8kHz の WAV（調査は見出しだけを読むので、途中の標本を書き換えても調査の結果は変わらない）。 */
function wav(samples:number){const b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);for(let i=44;i<b.length;i+=2)b.writeInt16LE(i%100,i);return b;}
it('refuses a file swapped for another while ffprobe is reading the opened file, before reading it in full, and registers nothing',async()=>{
  const source=join(root,'probe-swap.mp4'),other=join(root,'probe-other.mp4'),dir=project();copyFileSync(samples.first,source);copyFileSync(samples.third25,other);
  const path=realpathSync(source),phases:string[]=[];reads.bytes.clear();probing.during=()=>renameSync(other,source);
  await expect(registerSequenceReferenceDetailed(dir,source,'probe-swap.mp4',undefined,undefined,{onPhase:phase=>phases.push(phase),onProbed:()=>phases.push('probed')}))
    .rejects.toThrow('確認中に参照先が変更されました');
  expect(probing.ran).toBe(true);expect(phases).toEqual(['probing']);expect(reads.bytes.get(path)??0).toBe(0);
  expect(await registeredSequenceReferences(dir)).toEqual([]);
});
it('refuses a file overwritten in place while ffprobe is reading the opened file and registers nothing',async()=>{
  const source=join(root,'probe-overwrite.wav'),dir=project(),bytes=wav(8000);writeFileSync(source,bytes);
  const path=realpathSync(source),phases:string[]=[];reads.bytes.clear();
  probing.during=()=>{const fd=openSync(source,'r+');try{writeSync(fd,Buffer.alloc(64,0x55),0,64,bytes.length/2);}finally{closeSync(fd);}};
  await expect(registerSequenceReferenceDetailed(dir,source,'probe-overwrite.wav',undefined,undefined,{onPhase:phase=>phases.push(phase),onProbed:()=>phases.push('probed')}))
    .rejects.toThrow('確認中に参照先が変更されました');
  expect(probing.ran).toBe(true);expect(statSync(source).size).toBe(bytes.length);expect(phases).toEqual(['probing']);expect(reads.bytes.get(path)??0).toBe(0);
  expect(await registeredSequenceReferences(dir)).toEqual([]);
});
it('refuses a folder on the path swapped while ffprobe is reading the opened file (only the path side can see it) and registers nothing',async()=>{
  // 開いた実体は動かない（途中のフォルダの名前を変えても、中のファイルの dev/ino/size/mtime/ctime は変わらない）ので、分かるのはパスの先の照合だけ。
  const base=mkdtempSync(join(root,'folder-swap-')),folder=join(base,'take'),other=join(base,'other'),source=join(folder,'clip.mp4'),dir=project();
  mkdirSync(folder);mkdirSync(other);copyFileSync(samples.first,source);copyFileSync(samples.third25,join(other,'clip.mp4'));
  const path=realpathSync(source),opened=statSync(path),phases:string[]=[];reads.bytes.clear();
  probing.during=()=>{renameSync(folder,join(base,'take-old'));renameSync(other,folder);};
  await expect(registerSequenceReferenceDetailed(dir,source,'clip.mp4',undefined,undefined,{onPhase:phase=>phases.push(phase),onProbed:()=>phases.push('probed')}))
    .rejects.toThrow('確認中に参照先が変更されました');
  const moved=statSync(join(base,'take-old','clip.mp4'));
  expect(probing.ran).toBe(true);expect([moved.ino,moved.ctimeMs,moved.mtimeMs,moved.size]).toEqual([opened.ino,opened.ctimeMs,opened.mtimeMs,opened.size]);
  expect(statSync(path).ino).not.toBe(opened.ino);expect(phases).toEqual(['probing']);expect(reads.bytes.get(path)??0).toBe(0);
  expect(await registeredSequenceReferences(dir)).toEqual([]);
});

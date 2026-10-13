import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {copyFile,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,truncate,unlink,writeFile} from 'node:fs/promises';
import {execFileSync,type ChildProcess,type SpawnOptions} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SequenceAsset,SequenceDocument} from '../../core/sequence/model';
import {rational,timeNumber,type Rational} from '../../core/sequence/time';

/**
 * 倍速の音声は「同じ素材・同じストリームの1倍の保存（PCM）」から作り、元の素材を読まない（2026-10-04・倍速で「音声を準備しています…」が長く続く不具合）。
 * 元の素材を読んだかは、起動した ffmpeg に渡した入力（fd 3）が元の素材と同じファイル（dev・ino）かで数える。
 */
const probe=vi.hoisted(()=>({
  spawned:[] as Array<{args:readonly string[];input?:string;child:ChildProcess}>,
  /** 1倍の保存を開く直前に1回だけ割り込む（読む直前に消える・縮む・リンクに替わる競合の再現）。 */
  beforeOpen:undefined as undefined|{path:string;act:()=>Promise<void>},
  lanes:[] as Array<{rank:number}>,
  /** ffmpeg を起動した直後に呼ぶ（実行中に1倍の保存を書き換える再現）。 */
  onSpawn:undefined as undefined|((entry:{args:readonly string[];input?:string})=>void),
  /** unlink の記録と、失敗させるパス（EACCES）。 */
  unlinked:[] as string[],
  unlinkFails:new Set<string>(),
}));
vi.mock('node:child_process',async load=>{
  const actual=await load<typeof import('node:child_process')>(),{fstatSync}=await import('node:fs');
  const spawn=(command:string,args:readonly string[],options:SpawnOptions)=>{
    const fd=Array.isArray(options?.stdio)?options.stdio[3]:undefined;
    const input=typeof fd==='number'?(info=>`${info.dev}:${info.ino}`)(fstatSync(fd)):undefined;
    const child=actual.spawn(command,args,options);
    if(/ffmpeg$/.test(command)){probe.spawned.push({args,input,child});probe.onSpawn?.({args,input});}
    return child;
  };
  return {...actual,spawn};
});
vi.mock('node:fs/promises',async load=>{
  const actual=await load<typeof import('node:fs/promises')>();
  const open=(async(path:Parameters<typeof actual.open>[0],...rest:unknown[])=>{
    const hook=probe.beforeOpen;
    if(hook&&path===hook.path){probe.beforeOpen=undefined;await hook.act();}
    return (actual.open as (...args:unknown[])=>ReturnType<typeof actual.open>)(path,...rest);
  }) as typeof actual.open;
  const unlink=(async(path:Parameters<typeof actual.unlink>[0])=>{
    probe.unlinked.push(String(path));
    if(probe.unlinkFails.has(String(path)))throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(path)}'`),{code:'EACCES'});
    return actual.unlink(path);
  }) as typeof actual.unlink;
  return {...actual,open,unlink,default:{...actual,open,unlink}};
});
vi.mock('./ffmpegGate',async load=>{
  const actual=await load<typeof import('./ffmpegGate')>();
  return {...actual,withFfmpegSlot:(lane:{rank:number},signal:AbortSignal|undefined,work:()=>Promise<unknown>)=>{probe.lanes.push(lane);return actual.withFfmpegSlot(lane,signal,work);}};
});
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {forgetAudioCacheRetirement,inspectSequenceAsset,prepareSequenceAudio} from './media';
import {importSequenceAsset} from './assets';
import {ffmpegGate} from './ffmpegGate';

let fixtures:string,ffmpeg:string;
const roots:string[]=[];
beforeAll(async()=>{
  fixtures=await mkdtemp(join(tmpdir(),'harness-speed-saved-'));
  const resolved=resolveFfmpegBin();if(!resolved.ok)throw new Error(resolved.message);ffmpeg=resolved.bin;
  const make=(...args:string[])=>execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args]);
  // 主素材と同じ形（AAC・48kHz・2ch）、BGM・効果音と同じ形（24bit WAV・48kHz・2ch）、48kHz でない素材（16bit WAV・44.1kHz・1ch）。
  make('-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-f','lavfi','-i','sine=frequency=660:sample_rate=48000','-filter_complex','[0][1]amerge=inputs=2','-t','1.5','-c:a','aac','-b:a','192k',join(fixtures,'aac.m4a'));
  make('-f','lavfi','-i','anoisesrc=sample_rate=48000:amplitude=0.3:seed=7','-t','1','-ac','2','-c:a','pcm_s24le',join(fixtures,'s24.wav'));
  make('-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','2','-c:a','pcm_s16le',join(fixtures,'s16-441.wav'));
},20000);
afterEach(()=>{probe.spawned.length=0;probe.lanes.length=0;probe.beforeOpen=undefined;probe.onSpawn=undefined;probe.unlinked.length=0;probe.unlinkFails.clear();vi.restoreAllMocks();delete process.env.HARNESS_TEST_FFMPEG_DELAY_MS;});
afterAll(async()=>{for(const root of [fixtures,...roots])if(root)await rm(root,{recursive:true,force:true});});

async function project(file='aac.m4a'):Promise<{root:string;asset:SequenceAsset;stream:number;source:string}>{
  // 保存先は実パスで作られる（macOS の一時フォルダはリンク経由）。
  const root=await realpath(await mkdtemp(join(tmpdir(),'harness-speed-project-')));roots.push(root);
  const source=join(root,file);await copyFile(join(fixtures,file),source);
  const asset=await inspectSequenceAsset(root,file,file);
  return {root,asset,stream:asset.streams.find(s=>s.kind==='audio')!.index,source};
}
const identity=async(path:string)=>{const info=await stat(path);return `${info.dev}:${info.ino}`;};
/** 元の素材（または指定のファイル）を入力にした ffmpeg の数。 */
const readsOf=async(path:string)=>{const id=await identity(path);return probe.spawned.filter(entry=>entry.input===id).length;};
/** 修正前の1倍の保存キー（作り方の版 pcm-v1）。1倍はこのキーのまま、倍速はこのキーを使わない。 */
async function legacyPath(root:string,asset:SequenceAsset,stream:number,rate:Rational):Promise<string>{
  const info=await stat(join(root,asset.file));
  const key=createHash('sha256').update(JSON.stringify([asset.fingerprint,stream,rate,info.size,info.mtimeMs,'pcm-v1-48000-stereo'])).digest('hex');
  return join(root,'.harness/cache/audio',`${key}.f32le`);
}
function tempo(rate:Rational):string[]{
  const filters:string[]=[];let value=timeNumber(rate);
  while(value>2){filters.push('atempo=2');value/=2;}while(value<.5){filters.push('atempo=0.5');value/=.5;}if(value!==1)filters.push(`atempo=${value}`);
  return filters;
}
/** 修正前の作り方（元の素材 → atempo → 48kHz・2ch の f32le）。 */
function fromSource(path:string,stream:number,rate:Rational):Buffer{
  return execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-i',path,'-map',`0:${stream}`,'-vn','-af',tempo(rate).join(','),'-ac','2','-ar','48000','-f','f32le','pipe:1'],{maxBuffer:1<<28});
}
const floats=(data:Buffer)=>new Float32Array(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
function dominantFrequency(data:Buffer):number{
  const values=floats(data),crossings:number[]=[];
  for(let frame=1500;frame<values.length/2-1500;frame++)if(values[(frame-1)*2]!<=0&&values[frame*2]!>0)crossings.push(frame);
  return 48000*(crossings.length-1)/(crossings.at(-1)!-crossings[0]!);
}
const rmsDb=(data:Buffer)=>{let sum=0;const values=floats(data);for(const value of values)sum+=value*value;return 10*Math.log10(sum/values.length);};

describe('倍速の音声は1倍の保存から作る（元の素材を読まない）',()=>{
  it('1倍の保存があれば、倍速の ffmpeg は1倍の保存だけを読み、元の素材を読まない',async()=>{
    const {root,asset,stream,source}=await project();
    const one=await prepareSequenceAudio(root,asset,stream,rational(1));
    expect(await readsOf(source)).toBe(1);
    probe.spawned.length=0;
    const fast=await prepareSequenceAudio(root,asset,stream,rational(2));
    expect(await readsOf(source)).toBe(0);
    expect(probe.spawned).toHaveLength(1);
    expect(probe.spawned[0]!.input).toBe(await identity(one.file));
    expect(probe.spawned[0]!.args).toContain('atempo=2');
    expect(fast).toMatchObject({sampleRate:48000,channels:2,rate:rational(2)});
  },20000);
  it('参照（リンク）素材でも、1倍の保存があれば元の素材を読まない',async()=>{
    const root=await mkdtemp(join(tmpdir(),'harness-speed-reference-'));roots.push(root);
    const outside=await mkdtemp(join(tmpdir(),'harness-speed-external-'));roots.push(outside);
    const source=join(outside,'camera.m4a');await copyFile(join(fixtures,'aac.m4a'),source);
    const {registerSequenceReference}=await import('./references');
    const asset=await registerSequenceReference(root,source),stream=asset.streams.find(s=>s.kind==='audio')!.index;
    const one=await prepareSequenceAudio(root,asset,stream,rational(1));
    probe.spawned.length=0;
    await prepareSequenceAudio(root,asset,stream,rational(4));
    expect(await readsOf(source)).toBe(0);
    expect(probe.spawned.map(entry=>entry.input)).toEqual([await identity(one.file)]);
  },20000);

  it('(a) AAC・48kHz・2ch は、元から作った倍速とバイト単位で一致する（2・4・8・1.25・0.5倍）',async()=>{
    const {root,asset,stream,source}=await project();
    for(const rate of [rational(2),rational(4),rational(8),rational(5,4),rational(1,2)]){
      const prepared=await prepareSequenceAudio(root,asset,stream,rate);
      expect(await readFile(prepared.file)).toEqual(fromSource(source,stream,rate));
    }
  },30000);
  it('(a) 24bit WAV・48kHz は、長さが一致し、差は24bit の最小単位（2^-23）未満（整数→小数の変換の順だけが違う）',async()=>{
    const {root,asset,stream,source}=await project('s24.wav');
    for(const rate of [rational(2),rational(8)]){
      const actual=floats(await readFile((await prepareSequenceAudio(root,asset,stream,rate)).file)),expected=floats(fromSource(source,stream,rate));
      expect(actual.length).toBe(expected.length);
      let max=0;for(let i=0;i<actual.length;i++)max=Math.max(max,Math.abs(actual[i]!-expected[i]!));
      expect(max).toBeLessThan(2**-23);
    }
  },20000);
  it('(a) 44.1kHz の素材は、音程・音量が同じで、長さは元から作った倍速と同じく「素材の長さ÷速度」から atempo の窓（2048サンプル）以内',async()=>{
    // 1倍の保存はすでに 48kHz なので、atempo の継ぎ目の位置は修正前（44.1kHz で早回し→48kHz）と同じにならない（波形のサンプル比較はできない）。
    // 修正前と一致しないのは 44.1kHz の WAV・44.1kHz モノラルの AAC・5.1ch（44.1kHz ステレオの AAC/MP3 と 48kHz・2ch は一致する。2026-10-04 レビューの実測）。
    const {root,asset,stream,source}=await project('s16-441.wav');
    const rate=rational(2),actual=await readFile((await prepareSequenceAudio(root,asset,stream,rate)).file),expected=fromSource(source,stream,rate);
    const ideal=2/2*48000;
    expect(Math.abs(actual.length/8-ideal)).toBeLessThanOrEqual(2048);
    expect(Math.abs(expected.length/8-ideal)).toBeLessThanOrEqual(2048);
    expect(dominantFrequency(actual)).toBeCloseTo(dominantFrequency(expected),0);
    expect(dominantFrequency(actual)).toBeCloseTo(440,0);
    expect(Math.abs(rmsDb(actual)-rmsDb(expected))).toBeLessThan(.05);
  },20000);

  it('(b) 1倍の保存が無ければ、先に1倍を今の作り方で作って保存し、それから倍速を作る（元の読みは1倍の1回だけ）',async()=>{
    const {root,asset,stream,source}=await project();
    const fast=await prepareSequenceAudio(root,asset,stream,rational(2));
    const one=await legacyPath(root,asset,stream,rational(1));
    expect(await readsOf(source)).toBe(1);
    expect(probe.spawned.map(entry=>entry.input)).toEqual([await identity(source),await identity(one)]);
    expect(probe.spawned[0]!.args).not.toContain('-af');
    expect(await readFile(fast.file)).toEqual(fromSource(source,stream,rational(2)));
    probe.spawned.length=0;
    expect((await prepareSequenceAudio(root,asset,stream,rational(1))).file).toBe(one);
    expect(probe.spawned).toHaveLength(0);
  },20000);

  it('(c) 1倍の保存のキーは今のまま、古い版（元から作った）倍速の保存は使わない',async()=>{
    const {root,asset,stream,source}=await project();
    expect((await prepareSequenceAudio(root,asset,stream,rational(1))).file).toBe(await legacyPath(root,asset,stream,rational(1)));
    // 修正前の版の 2倍の保存（中身は無音）を置く。正しい形のメタデータでも使わない。
    const old=await legacyPath(root,asset,stream,rational(2)),silent=Buffer.alloc(36000*8);
    await writeFile(old,silent);await writeFile(old+'.json',JSON.stringify({file:old,sampleRate:48000,channels:2,sampleCount:36000,rate:rational(2)})+'\n');
    probe.spawned.length=0;
    const fast=await prepareSequenceAudio(root,asset,stream,rational(2));
    expect(fast.file).not.toBe(old);
    expect(probe.spawned).toHaveLength(1);
    expect(await readFile(fast.file)).toEqual(fromSource(source,stream,rational(2)));
    expect(await readFile(old)).toEqual(silent);
  },20000);

  describe('(d) 1倍の保存が壊れている・消えた時',()=>{
    const broken:Array<[string,(one:string)=>Promise<void>]>=[
      ['PCM が途中で切れている',async one=>truncate(one,(await stat(one)).size/2)],
      ['メタデータが壊れている',async one=>writeFile(one+'.json','{"broken"')],
      ['PCM が消えた（メタデータは残る）',async one=>unlink(one)],
      ['メタデータが消えた',async one=>unlink(one+'.json')],
    ];
    it.each(broken)('%s: 1倍を元から作り直してから倍速を作る',async(_name,damage)=>{
      const {root,asset,stream,source}=await project();
      const one=(await prepareSequenceAudio(root,asset,stream,rational(1))).file;
      await damage(one);probe.spawned.length=0;
      const fast=await prepareSequenceAudio(root,asset,stream,rational(2));
      expect(await readsOf(source)).toBe(1);
      expect(probe.spawned).toHaveLength(2);
      expect(await readFile(fast.file)).toEqual(fromSource(source,stream,rational(2)));
    },20000);
    it('リンクに置き換わっている: 断り、リンク先を読まない',async()=>{
      const {root,asset,stream}=await project();
      const one=(await prepareSequenceAudio(root,asset,stream,rational(1))).file,decoy=join(root,'decoy.f32le');
      await writeFile(decoy,await readFile(one));await unlink(one);await symlink(decoy,one);probe.spawned.length=0;
      await expect(prepareSequenceAudio(root,asset,stream,rational(2))).rejects.toThrow();
      expect(await readsOf(decoy)).toBe(0);
      expect(probe.spawned).toHaveLength(0);
    },20000);
    const races:Array<[string,(one:string,decoy:string)=>Promise<void>]>=[
      ['読む直前に消えた',async one=>unlink(one)],
      ['読む直前に縮んだ',async one=>truncate(one,8)],
    ];
    it.each(races)('%s: 1回だけ1倍を作り直して倍速を作る',async(_name,act)=>{
      const {root,asset,stream,source}=await project();
      const one=(await prepareSequenceAudio(root,asset,stream,rational(1))).file;probe.spawned.length=0;
      probe.beforeOpen={path:one,act:()=>act(one,'')};
      const fast=await prepareSequenceAudio(root,asset,stream,rational(2));
      expect(probe.beforeOpen).toBeUndefined();
      expect(await readsOf(source)).toBe(1);
      expect(await readFile(fast.file)).toEqual(fromSource(source,stream,rational(2)));
    },20000);
    it('読む直前にリンクへ置き換わった: リンクをたどらずに断る',async()=>{
      const {root,asset,stream,source}=await project();
      const one=(await prepareSequenceAudio(root,asset,stream,rational(1))).file,decoy=join(root,'decoy.f32le');
      await writeFile(decoy,await readFile(one));probe.spawned.length=0;
      probe.beforeOpen={path:one,act:async()=>{await unlink(one);await symlink(decoy,one);}};
      await expect(prepareSequenceAudio(root,asset,stream,rational(2))).rejects.toThrow();
      expect(probe.beforeOpen).toBeUndefined();
      expect(await readsOf(decoy)).toBe(0);
      expect(await readsOf(source)).toBe(0);
    },20000);
  });

  it('(e) クリップに登録した速度（content.rate ≠ 1）の書き出しも、1倍の保存から作る',async()=>{
    const {root,asset,stream,source}=await project();
    const {ScenePlan}=await import('../../core/sequence/scenePlan'),{writeSequenceAudio}=await import('./exportAudio');
    const doc:SequenceDocument={schemaVersion:2,id:'speed',name:'速度',revision:0,fps:rational(30),resolution:{width:2,height:2},sequenceEndFrame:30,background:'#000000',assets:[asset],
      tracks:[{id:'a',kind:'audio',name:'A',enabled:true}],clips:[{id:'clip',trackId:'a',name:'音',startFrame:0,durationFrames:30,clock:{offset:rational(0),rate:rational(1),duration:rational(30)},
        content:{kind:'audio',assetId:asset.id,streamIndex:stream,sourceIn:rational(0),rate:rational(3,2),role:'music',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],
      transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
    await writeSequenceAudio(new ScenePlan(doc),root,join(root,'mixed.f32le'),new AbortController().signal);
    const one=await legacyPath(root,asset,stream,rational(1));
    expect(await readsOf(source)).toBe(1);
    expect(probe.spawned.map(entry=>entry.input)).toEqual([await identity(source),await identity(one)]);
    expect(probe.spawned[1]!.args).toContain('atempo=1.5');
  },20000);

  describe('(f) 取り消し・同時要求の合流',()=>{
    it('同時の 2倍・2倍・4倍: 元の読みは1倍の1回だけ、倍速の作成は速度ごとに1回',async()=>{
      const {root,asset,stream,source}=await project();
      const [a,b,c]=await Promise.all([rational(2),rational(2),rational(4)].map(rate=>prepareSequenceAudio(root,asset,stream,rate)));
      expect(a).toEqual(b);expect(c!.file).not.toBe(a!.file);
      expect(await readsOf(source)).toBe(1);
      expect(probe.spawned).toHaveLength(3);
    },20000);
    it('倍速の要求を取り消すと、その要求だけが待つ1倍の作成も止まり、何も保存しない',async()=>{
      const {root,asset,stream}=await project();
      process.env.HARNESS_TEST_FFMPEG_DELAY_MS='400';
      const controller=new AbortController(),request=prepareSequenceAudio(root,asset,stream,rational(2),controller.signal);
      const rejected=expect(request).rejects.toThrow('取り消し');
      await vi.waitFor(()=>expect(ffmpegGate.stats.active).toBeGreaterThan(0));
      controller.abort(new Error('取り消し'));await rejected;
      await vi.waitFor(()=>expect(ffmpegGate.stats.active).toBe(0));
      await new Promise(resolve=>setTimeout(resolve,100));
      expect(probe.spawned).toHaveLength(0);
      expect((await readdir(join(root,'.harness/cache/audio'))).filter(name=>/^[0-9a-f]{64}\.f32le/.test(name)&&!name.endsWith('.tmp'))).toEqual([]);
      delete process.env.HARNESS_TEST_FFMPEG_DELAY_MS;
      expect((await prepareSequenceAudio(root,asset,stream,rational(2))).sampleCount).toBeGreaterThan(0);
    },20000);
    it('1倍を待つ別の呼び手（波形の準備など）がいれば、倍速を取り消しても1倍は作り終えて保存する',async()=>{
      const {root,asset,stream,source}=await project();
      process.env.HARNESS_TEST_FFMPEG_DELAY_MS='300';
      const waveform=prepareSequenceAudio(root,asset,stream,rational(1),undefined,'waveform');
      const controller=new AbortController(),request=prepareSequenceAudio(root,asset,stream,rational(2),controller.signal);
      const rejected=expect(request).rejects.toThrow('取り消し');
      await vi.waitFor(()=>expect(ffmpegGate.stats.active).toBeGreaterThan(0));
      await new Promise(resolve=>setTimeout(resolve,50));
      controller.abort(new Error('取り消し'));await rejected;
      const one=await waveform;
      expect((await stat(one.file)).size).toBe(one.sampleCount*8);
      expect(await readsOf(source)).toBe(1);
      expect(probe.spawned).toHaveLength(1);
    },20000);
    it('急ぐ呼び手（再生）が後から合流したら、待っている1倍の作成の順位も上げる',async()=>{
      const {root,asset,stream}=await project();
      process.env.HARNESS_TEST_FFMPEG_DELAY_MS='300';
      const background=prepareSequenceAudio(root,asset,stream,rational(2),undefined,'waveform');
      await vi.waitFor(()=>expect(probe.lanes).toHaveLength(1));
      expect(probe.lanes[0]!.rank).toBe(1);
      const playback=prepareSequenceAudio(root,asset,stream,rational(2),undefined,'audio');
      await Promise.all([background,playback]);
      expect(probe.lanes).toHaveLength(2);
      expect(probe.lanes.map(lane=>lane.rank)).toEqual([0,0]);
    },20000);
    it('倍速の保存がすでにあれば、裏で作っている1倍の順位は上げない',async()=>{
      const {root,asset,stream}=await project();
      const fast=await prepareSequenceAudio(root,asset,stream,rational(2));
      const one=await legacyPath(root,asset,stream,rational(1));await unlink(one);await unlink(one+'.json');
      probe.spawned.length=0;probe.lanes.length=0;process.env.HARNESS_TEST_FFMPEG_DELAY_MS='300';
      const waveform=prepareSequenceAudio(root,asset,stream,rational(1),undefined,'waveform');
      await vi.waitFor(()=>expect(probe.lanes).toHaveLength(1));
      expect((await prepareSequenceAudio(root,asset,stream,rational(2),undefined,'audio')).file).toBe(fast.file);
      expect(probe.lanes[0]!.rank).toBe(1);
      await waveform;
    },20000);
  });
  /** 倍速の ffmpeg（1倍の保存を読む）を起動した直後に、1倍の保存を大きさを変えずに書き換える（メタデータの長さの照合では見つからない）。 */
  async function rewriteSavedDuringStretch(one:string,times:number){
    const {openSync,writeSync,closeSync,utimesSync}=await import('node:fs');let left=times;
    probe.onSpawn=entry=>{
      if(!entry.args.includes('f32le')||entry.args.indexOf('f32le')>entry.args.indexOf('-i')||left<=0)return;left--;
      const fd=openSync(one,'r+');try{writeSync(fd,Buffer.alloc(64,1),0,64,0);}finally{closeSync(fd);}utimesSync(one,new Date(),new Date(Date.now()+60_000));
    };
  }
  it('倍速を作っている間に1倍の保存が一度書き換わったら、書き換わった1倍は使わず、元から作り直した1倍から作る',async()=>{
    const {root,asset,stream,source}=await project();
    const one=(await prepareSequenceAudio(root,asset,stream,rational(1))).file,original=await readFile(one);
    await rewriteSavedDuringStretch(one,1);probe.spawned.length=0;
    const fast=await prepareSequenceAudio(root,asset,stream,rational(2));
    expect(await readsOf(source)).toBe(1);
    expect(await readFile(one)).toEqual(original);
    expect(await readFile(fast.file)).toEqual(fromSource(source,stream,rational(2)));
  },20000);
  it('作り直した1倍も書き換わったら、その要求は失敗し、倍速は保存しない（読み終えた後の確認）',async()=>{
    const {root,asset,stream,source}=await project();
    const one=(await prepareSequenceAudio(root,asset,stream,rational(1))).file;
    await rewriteSavedDuringStretch(one,Infinity);probe.spawned.length=0;
    await expect(prepareSequenceAudio(root,asset,stream,rational(2))).rejects.toThrow();
    expect(await readsOf(source)).toBe(1);
    expect(probe.spawned).toHaveLength(3);
    const names=await readdir(join(root,'.harness/cache/audio'));
    expect(names.filter(name=>/^[0-9a-f]{64}\.f32le$/.test(name))).toEqual([one.split('/').at(-1)]);
  },20000);
});

describe('古い版（元の素材から作った）倍速の保存を消す',()=>{
  const MARKER='.retired-stretched-pcm-v1';
  async function registered(file='aac.m4a'){
    const root=await realpath(await mkdtemp(join(tmpdir(),'harness-retire-')));roots.push(root);
    const asset=await importSequenceAsset(root,join(fixtures,file));
    return {root,asset,stream:asset.streams.find(s=>s.kind==='audio')!.index};
  }
  /** 修正前の版の倍速の保存（PCM・メタデータ・波形の索引）を置く。 */
  async function plant(root:string,asset:SequenceAsset,stream:number,rate:Rational,waveform=true):Promise<string>{
    const path=await legacyPath(root,asset,stream,rate);
    await mkdir(join(root,'.harness/cache/audio'),{recursive:true});
    await writeFile(path,Buffer.alloc(800));await writeFile(path+'.json',JSON.stringify({file:path,sampleRate:48000,channels:2,sampleCount:100,rate})+'\n');
    if(waveform)await writeFile(path+'.waveform-v1',Buffer.alloc(16));
    return path;
  }
  const exists=(path:string)=>stat(path).then(()=>true,()=>false);
  const linkExists=async(path:string)=>{try{return (await lstat(path)).isSymbolicLink();}catch{return false;}};
  /** 1回目の準備（掃除・目印）を済ませ、目印を消して再起動に相当させる。 */
  async function restart(root:string){await rm(join(root,'.harness/cache/audio',MARKER),{force:true});forgetAudioCacheRetirement();}

  it('旧版の倍速だけを PCM → 波形の索引 → メタデータの順に消し、1倍・新版・別の案件・リンクを含む組・名前の合わないファイル・登録外の素材は残す',async()=>{
    const {root,asset,stream}=await registered();
    const one=await prepareSequenceAudio(root,asset,stream,rational(1)),fresh=await prepareSequenceAudio(root,asset,stream,rational(2));
    const old2=await plant(root,asset,stream,rational(2)),old4=await plant(root,asset,stream,rational(4),false);
    const linked=await legacyPath(root,asset,stream,rational(8)),decoy=join(root,'decoy.f32le');
    await writeFile(decoy,Buffer.alloc(800));await symlink(decoy,linked);await writeFile(linked+'.json',JSON.stringify({file:linked,sampleRate:48000,channels:2,sampleCount:100,rate:rational(8)}));
    const misnamed=[old2+'.bak',join(root,'.harness/cache/audio','NOTES.txt'),join(root,'.harness/cache/audio',old2.split('/').at(-1)!.slice(1))];
    for(const path of misnamed)await writeFile(path,'keep');
    // 登録していない素材（案件の直下に置いただけ）の旧版の倍速
    await copyFile(join(fixtures,'s24.wav'),join(root,'loose.wav'));
    const loose=await inspectSequenceAsset(root,'loose.wav','loose'),looseOld=await plant(root,loose,loose.streams.find(s=>s.kind==='audio')!.index,rational(2));
    // 別の案件の旧版の倍速
    const other=await registered(),otherOld=await plant(other.root,other.asset,other.stream,rational(2));
    await restart(root);probe.unlinked.length=0;
    expect((await prepareSequenceAudio(root,asset,stream,rational(2))).file).toBe(fresh.file);
    for(const path of [old2,old2+'.waveform-v1',old2+'.json',old4,old4+'.json'])expect(await exists(path)).toBe(false);
    expect(probe.unlinked.filter(path=>path.startsWith(old2))).toEqual([old2,old2+'.waveform-v1',old2+'.json']);
    for(const path of [one.file,one.file+'.json',fresh.file,fresh.file+'.json',decoy,linked+'.json',...misnamed,looseOld,looseOld+'.json',otherOld,otherOld+'.json',otherOld+'.waveform-v1'])expect(await exists(path)).toBe(true);
    expect(await linkExists(linked)).toBe(true);
    expect(await exists(join(root,'.harness/cache/audio',MARKER))).toBe(true);
  },30000);
  it('消す途中の失敗は記録して飛ばし、再生の準備は止めない（目印は置かず、次の起動でやり直す）',async()=>{
    const {root,asset,stream}=await registered();
    await prepareSequenceAudio(root,asset,stream,rational(1));
    const old2=await plant(root,asset,stream,rational(2)),old4=await plant(root,asset,stream,rational(4));
    await restart(root);probe.unlinkFails.add(old2);
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    expect((await prepareSequenceAudio(root,asset,stream,rational(2))).sampleCount).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    expect(await exists(old2)).toBe(true);expect(await exists(old2+'.json')).toBe(true);expect(await exists(old4)).toBe(false);
    expect(await exists(join(root,'.harness/cache/audio',MARKER))).toBe(false);
    probe.unlinkFails.clear();forgetAudioCacheRetirement();
    await prepareSequenceAudio(root,asset,stream,rational(2));
    expect(await exists(old2)).toBe(false);expect(await exists(old2+'.json')).toBe(false);
  },30000);
  it('一度終えたら、同じプロセスでは2回目を動かさず、再起動後も目印があれば動かさない',async()=>{
    const {root,asset,stream}=await registered();
    await prepareSequenceAudio(root,asset,stream,rational(1));
    const marker=join(root,'.harness/cache/audio',MARKER);
    expect(await exists(marker)).toBe(true);
    // 同じプロセスでは、目印が無くても2回目は動かない。
    await rm(marker);const old2=await plant(root,asset,stream,rational(2));
    await prepareSequenceAudio(root,asset,stream,rational(1));
    expect(await exists(old2)).toBe(true);
    // 再起動後も、目印があれば動かない。
    await writeFile(marker,'');forgetAudioCacheRetirement();
    await prepareSequenceAudio(root,asset,stream,rational(1));
    expect(await exists(old2)).toBe(true);
    await restart(root);
    await prepareSequenceAudio(root,asset,stream,rational(1));
    expect(await exists(old2)).toBe(false);
  },30000);
});

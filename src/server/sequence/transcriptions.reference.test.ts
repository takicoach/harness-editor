import {afterEach,expect,it,vi} from 'vitest';
const observation=vi.hoisted(()=>({beforeSpawn:null as (()=>void)|null,onSpawn:null as (()=>void)|null,events:[] as string[],fds:[] as number[],args:[] as string[][],extracted:null as Buffer|null}));
vi.mock('./assets',async load=>{
 const actual=await load<typeof import('./assets')>();return {...actual,openSequenceAsset:async(...args:Parameters<typeof actual.openSequenceAsset>)=>{
  const lease=await actual.openSequenceAsset(...args);observation.events.push('lease-open');return {...lease,verify:async()=>{observation.events.push('lease-verify');await lease.verify();},close:async()=>{observation.events.push('lease-close');await lease.close();}};
 }};
});
vi.mock('node:child_process',async load=>{
 const actual=await load<typeof import('node:child_process')>();const fs=await import('node:fs');
 return {...actual,spawn:(...args:Parameters<typeof actual.spawn>)=>{
  const command=args[1];const extracting=Array.isArray(command)&&command.includes('pcm_s16le');
  if(extracting){observation.args.push([...command]);observation.beforeSpawn?.();}
  const child=actual.spawn(...args);
  if(extracting){const stdio=args[2]?.stdio,fd=Array.isArray(stdio)?stdio[3]:undefined;
   if(typeof fd==='number')observation.fds.push(fd);
   child.once('spawn',()=>observation.onSpawn?.());
   child.once('close',()=>{observation.events.push('child-close');if(typeof fd==='number'){try{fs.fstatSync(fd);observation.events.push('fd-open-at-child-close');}catch{observation.events.push('fd-closed-too-soon');}}
    const output=command.at(-1)!;if(fs.existsSync(output))observation.extracted=fs.readFileSync(output);
   });
  }
  return child;
 }};
});
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {existsSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registerSequenceReference} from './references';
import {importSequenceAsset} from './assets';
import {SequenceStore} from './store';
import {SequenceService} from './service';
import {SequenceTranscriptions} from './transcriptions';
import {runSequenceTranscription} from './transcriptionRunner';
import {rational as r} from '../../core/sequence/time';
import type {SequenceDocument} from '../../core/sequence/model';
const owned:string[]=[];
function clear(){observation.beforeSpawn=null;observation.onSpawn=null;observation.events=[];observation.fds=[];observation.args=[];observation.extracted=null;}
afterEach(async()=>{clear();vi.unstubAllEnvs();for(const path of owned.splice(0))await rm(path,{recursive:true,force:true});});
function wav(frequency=440){const b=Buffer.alloc(44+2*8000*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let i=0;i<16000;i++)b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*frequency/8000)*16000),44+i*2);return b;}
async function fixture(reference=true){
 const root=await mkdtemp(join(tmpdir(),'native-transcription-reference-'));owned.push(root);const directory=join(root,'project'),source=join(root,'source.wav');await mkdir(directory);writeFileSync(source,wav());
 const asset=await (reference?registerSequenceReference:importSequenceAsset)(directory,source),document:SequenceDocument={schemaVersion:2,id:'doc',name:'原音',revision:0,fps:r(30),resolution:{width:2,height:2},sequenceEndFrame:60,background:'#000',assets:[asset],tracks:[{id:'audio',name:'原音',kind:'audio',enabled:true}],clips:[{id:'speech',name:'原音',trackId:'audio',startFrame:0,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'audio',assetId:asset.id,streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'}};
 const store=new SequenceStore(directory);store.save({document,executionId:'seed',expectedSavedRevision:null});const service=new SequenceService(),state=service.open(directory);clear();
 return {root,directory,source,asset,document,store,service,request:{sessionId:state.sessionId,expectedRevision:0,executionId:'transcribe',occurrenceId:'speech'}};
}
it('extracts reference and managed sources to identical WAV bytes using a fixed fd until child close',async()=>{
 vi.stubEnv('SME_TRANSCRIBE_MOCK','1');const extracted:Buffer[]=[];
 for(const reference of [true,false]){
  const f=await fixture(reference),jobs=new SequenceTranscriptions();const saved=await readFile(join(f.directory,'.harness/project.v2.json'));
  const status=jobs.start(f.directory,'owned',f.request,f.service);await jobs.job(f.directory,status.id).completion;
  expect(jobs.job(f.directory,status.id).data.status.phase).toBe('completed');expect(observation.extracted).not.toBeNull();extracted.push(observation.extracted!);
  expect(observation.args[0]).toEqual(expect.arrayContaining(['-fd','3','-i','fd:']));expect(observation.args[0]).not.toContain(f.source);expect(observation.fds).toHaveLength(1);
  expect(observation.events).toEqual(['lease-open','child-close','fd-open-at-child-close','lease-verify','lease-close']);
  expect(await readFile(join(f.directory,'.harness/project.v2.json'))).toEqual(saved);expect(f.service.open(f.directory).document).toEqual(f.document);
 }
 expect(extracted[0]).toEqual(extracted[1]);expect(extracted[0]!.length).toBeGreaterThan(64000);
},20000);
it('rejects a source exchanged before spawn, although FFmpeg still reads the originally leased bytes',async()=>{
 vi.stubEnv('SME_TRANSCRIBE_MOCK','1');const baseline=await fixture(),baselineDir=join(baseline.root,'extract');await mkdir(baselineDir);
 await runSequenceTranscription({root:baseline.directory,directory:baselineDir,asset:baseline.asset,streamIndex:0,runId:'baseline',signal:new AbortController().signal,progress:()=>{}});const expected=observation.extracted;
 const f=await fixture(),saved=await readFile(join(f.directory,'.harness/project.v2.json'));
 observation.beforeSpawn=()=>{renameSync(f.source,f.source+'.original');writeFileSync(f.source,wav(880));};
 const jobs=new SequenceTranscriptions(),status=jobs.start(f.directory,'owned',f.request,f.service);await jobs.job(f.directory,status.id).completion;const job=jobs.job(f.directory,status.id);
 expect(job.data.status.phase).toBe('failed');expect(observation.extracted).toEqual(expected);expect(observation.events).toContain('fd-open-at-child-close');expect(observation.events.at(-1)).toBe('lease-close');
 expect(()=>jobs.result(f.directory,status.id)).toThrow('完了');expect(existsSync(join(job.directory,'source.wav'))).toBe(false);expect(existsSync(join(job.directory,'params.json'))).toBe(false);expect(f.service.open(f.directory).document.transcripts).toEqual([]);expect(await readFile(join(f.directory,'.harness/project.v2.json'))).toEqual(saved);
},20000);
it('cancels extraction, waits for real child close, releases the lease and never publishes transcripts',async()=>{
 vi.stubEnv('SME_TRANSCRIBE_MOCK','1');const f=await fixture(),jobs=new SequenceTranscriptions();let id='';
 observation.onSpawn=()=>jobs.cancel(f.directory,id);const status=jobs.start(f.directory,'owned',f.request,f.service);id=status.id;await jobs.job(f.directory,id).completion;const job=jobs.job(f.directory,id);
 expect(job.data.status.phase).toBe('cancelled');expect(observation.events).toEqual(['lease-open','child-close','fd-open-at-child-close','lease-close']);
 expect(existsSync(join(job.directory,'source.wav'))).toBe(false);expect(()=>jobs.result(f.directory,id)).toThrow('完了');expect(f.service.open(f.directory).document).toEqual(f.document);
},15000);
it.each(['offline','decode-failure'] as const)('keeps transcripts unchanged on %s and closes any acquired descriptor',async kind=>{
 const f=await fixture();
 if(kind==='offline')renameSync(f.source,f.source+'.offline');
 else observation.beforeSpawn=()=>writeFileSync(f.source,'not an audio file');
 const jobs=new SequenceTranscriptions(),status=jobs.start(f.directory,'owned',f.request,f.service);await jobs.job(f.directory,status.id).completion;const job=jobs.job(f.directory,status.id);
 expect(job.data.status.phase).toBe('failed');expect(()=>jobs.result(f.directory,status.id)).toThrow('完了');expect(f.service.open(f.directory).document).toEqual(f.document);
 expect(existsSync(join(job.directory,'source.wav'))).toBe(false);expect(existsSync(join(job.directory,'params.json'))).toBe(false);
 expect(observation.events).toEqual(kind==='offline'?[]:['lease-open','child-close','fd-open-at-child-close','lease-close']);
});

import { afterEach,beforeAll,afterAll,expect,it,vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { readFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SequenceTranscriptions } from './transcriptions';
import { runSequenceTranscription,runTranscriptionProcess } from './transcriptionRunner';
import { importSequenceAsset } from './assets';
import { SequenceService } from './service';
import { SequenceStore } from './store';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { rational as r } from '../../core/sequence/time';
import type { SequenceDocument } from '../../core/sequence/model';
import { parseGeneratedTranscript } from '../../core/sequence/transcript';

let media:string;const directories:string[]=[];
beforeAll(async()=>{
  media=await mkdtemp(join(tmpdir(),'native-transcribe-media-'));
  const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=size=128x72:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
    '-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-map','0:v','-map','1:a','-map','2:a','-t','2','-c:v','libx264','-c:a','aac',join(media,'source.mp4')]);
},15000);
afterAll(async()=>{await rm(media,{recursive:true,force:true});});
afterEach(async()=>{vi.unstubAllEnvs();for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'native-transcription-'));directories.push(directory);
  const asset=await importSequenceAsset(directory,join(media,'source.mp4'),'別の音声を選ぶ.mp4');
  const document:SequenceDocument={schemaVersion:2,id:'case',name:'原音',revision:0,fps:r(30),resolution:{width:128,height:72},sequenceEndFrame:30,background:'#000000',
    ducking:{enabled:false,strength:'mid'},assets:[asset],tracks:[{id:'a',kind:'audio',name:'原音',enabled:true}],
    clips:[{id:'speech',name:'原音',trackId:'a',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'audio',assetId:asset.id,streamIndex:2,
      sourceIn:r(1),rate:r(1,2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],transitions:[],
    transcripts:[{assetId:asset.id,streamIndex:2,words:[{id:'previous',text:'既存の原稿',start:r(0),end:r(1)}]}]};
  const store=new SequenceStore(directory);store.save({document,executionId:'initial',expectedSavedRevision:null});
  const service=new SequenceService(),state=service.open(directory);
  return {directory,asset,document,store,service,state,request:{sessionId:state.sessionId,expectedRevision:0,executionId:'generate',occurrenceId:'speech'}};
}
it('generates from the selected stream at original time; restart, explicit import, atomic Undo and retry preserve other edits',async()=>{
  vi.stubEnv('SME_TRANSCRIBE_MOCK','1');const f=await fixture();let frequency=0;
  const jobs=new SequenceTranscriptions(input=>runSequenceTranscription({...input,progress:value=>{
    input.progress(value);if(value.phase==='loading-model'){
      const wav=readFileSync(join(input.directory,'source.wav')),data=wav.indexOf(Buffer.from('data'))+8;
      let crossings=0;for(let i=1;i<16000;i++)if(wav.readInt16LE(data+(i-1)*2)<0&&wav.readInt16LE(data+i*2)>=0)crossings++;frequency=crossings;
    }
  }}));
  const status=jobs.start(f.directory,'case',f.request,f.service);
  expect(jobs.get('case')).toBeDefined();expect(jobs.activeCount()).toBe(1);
  expect(jobs.start(f.directory,'case',f.request,f.service).id).toBe(status.id);
  expect(()=>jobs.start(f.directory,'case',{...f.request,occurrenceId:'other'},f.service)).toThrow(/同じ実行/);
  await jobs.job(f.directory,status.id).completion;
  expect(jobs.job(f.directory,status.id).data.status).toMatchObject({phase:'completed',wordCount:2});expect(frequency).toBeGreaterThan(875);expect(frequency).toBeLessThan(885);
  expect(f.service.open(f.directory).document).toEqual(f.document);expect(existsSync(join(jobs.job(f.directory,status.id).directory,'source.wav'))).toBe(false);
  const recovered=new SequenceTranscriptions(),result=recovered.result(f.directory,status.id);expect(result.streamIndex).toBe(2);expect(result.words[0]!.start).toEqual(r(1,2));
  f.service.execute(f.directory,{sessionId:f.state.sessionId,expectedRevision:0,executionId:'other-edit',command:{type:'update-clip',clipId:'speech',patch:{name:'作業中の名前'}}});
  await expect(recovered.apply(f.directory,status.id,{sessionId:f.state.sessionId,expectedRevision:0,executionId:'stale'},f.service)).rejects.toThrow(/更新/);
  const apply={sessionId:f.state.sessionId,expectedRevision:1,executionId:'take-result'};
  const taken=await recovered.apply(f.directory,status.id,apply,f.service);expect(taken.document.transcripts[0]).toEqual(result);expect(taken.document.clips[0]!.name).toBe('作業中の名前');
  f.service.execute(f.directory,{sessionId:f.state.sessionId,expectedRevision:2,executionId:'undo',command:{type:'undo'}});
  expect(f.service.open(f.directory).document.transcripts).toEqual(f.document.transcripts);
  await recovered.apply(f.directory,status.id,apply,f.service);expect(f.service.open(f.directory).document.transcripts).toEqual(f.document.transcripts);
  expect(f.store.load()!.document.transcripts).toEqual(f.document.transcripts);
},20000);
it('cancels a running Python process, cleans the extracted audio, and never imports a partial result',async()=>{
  vi.stubEnv('SME_TRANSCRIBE_MOCK','1');vi.stubEnv('SME_TRANSCRIBE_MOCK_DELAY_MS','3000');const f=await fixture(),jobs=new SequenceTranscriptions();
  const status=jobs.start(f.directory,'case',f.request,f.service);
  await vi.waitFor(()=>expect(jobs.job(f.directory,status.id).data.status.phase).toBe('analyzing'),{timeout:8000});
  jobs.cancel(f.directory,status.id);await jobs.job(f.directory,status.id).completion;
  expect(jobs.job(f.directory,status.id).data.status.phase).toBe('cancelled');expect(jobs.activeCount()).toBe(0);
  expect(existsSync(join(jobs.job(f.directory,status.id).directory,'source.wav'))).toBe(false);
  expect(()=>jobs.result(f.directory,status.id)).toThrow(/完了/);expect(f.service.open(f.directory).document).toEqual(f.document);
},15000);
it('does not overwrite transcripts changed after generation, rejects tampered results, and surfaces a missing Python executable',async()=>{
  vi.stubEnv('SME_TRANSCRIBE_MOCK','1');const f=await fixture(),jobs=new SequenceTranscriptions();
  const status=jobs.start(f.directory,'case',f.request,f.service);await jobs.job(f.directory,status.id).completion;
  const before=f.document.transcripts[0]!,changed={...before,words:[{...before.words[0]!,text:'人が直した原稿'}]};
  f.service.execute(f.directory,{sessionId:f.state.sessionId,expectedRevision:0,executionId:'manual',command:{type:'set-transcript',transcript:changed,before,assetFingerprint:f.asset.fingerprint}});
  await expect(jobs.apply(f.directory,status.id,{sessionId:f.state.sessionId,expectedRevision:1,executionId:'conflict'},f.service)).rejects.toThrow(/生成中/);
  expect(f.service.open(f.directory).document.transcripts[0]).toEqual(changed);
  await writeFile(join(jobs.job(f.directory,status.id).directory,'result.json'),'{}');expect(()=>jobs.result(f.directory,status.id)).toThrow(/変更/);
  vi.stubEnv('SUPERMOVIE_PYTHON',join(f.directory,'missing-python'));
  const failed=jobs.start(f.directory,'case',{...f.request,executionId:'fail',expectedRevision:1},f.service);await jobs.job(f.directory,failed.id).completion;
  expect(jobs.job(f.directory,failed.id).data.status).toMatchObject({phase:'failed'});expect(jobs.activeCount()).toBe(0);
  const manifest=join(jobs.job(f.directory,failed.id).directory,'manifest.json'),value=JSON.parse(await readFile(manifest,'utf8'));value.status.phase='analyzing';await writeFile(manifest,JSON.stringify(value));
  expect(new SequenceTranscriptions().job(f.directory,failed.id).data.status).toMatchObject({phase:'failed',error:expect.stringContaining('サーバーが停止')});
},20000);
it('rejects invalid/reversed/out-of-media word times and retains exact millisecond source times',()=>{
  const stream={index:1,kind:'audio' as const,codec:'aac',duration:r(4,3)};
  expect(parseGeneratedTranscript({words:[{text:'原音',start:500,end:1333}]},'asset',stream,'run').words[0]!.end).toEqual(r(1333,1000));
  for(const words of [[{text:'x',start:1,end:1400}],[{text:'x',start:-1,end:1}],[{text:'x',start:2,end:1}],[{text:'x',start:2,end:3},{text:'y',start:1,end:2}]])expect(()=>parseGeneratedTranscript({words},'asset',stream,'run')).toThrow();
});
it('waits for exit after progress says complete, drains stderr, and terminates an uncooperative child on cancel',async()=>{
  const signal=new AbortController();let announced=false;
  await expect(runTranscriptionProcess(process.execPath,['-e','process.stdout.write("completed\\n");process.stderr.write("x".repeat(200000));process.exitCode=7;'],signal.signal,()=>{announced=true;})).rejects.toThrow();
  expect(announced).toBe(true);
  let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
  const running=runTranscriptionProcess(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000);'],signal.signal,ready);
  const stopped=expect(running).rejects.toThrow();await started;signal.abort();await stopped;
},8000);

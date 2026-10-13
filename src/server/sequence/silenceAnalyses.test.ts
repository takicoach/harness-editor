import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,readFile,writeFile,readdir,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SilenceAnalyses} from './silenceAnalyses';
import {SequenceService} from './service';
import {SequenceStore} from './store';
import {importSequenceAsset} from './assets';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {silenceFixture} from '../../core/sequence/silenceCut.fixture';
import {DEFAULT_SILENCE_SETTINGS as settings} from '../../shared/silenceCut';
import {acquireSilenceEnvelope} from './silenceEnvelope';

let root:string;const dirs:string[]=[];
beforeAll(async()=>{
  root=await mkdtemp(join(tmpdir(),'silence-media-'));const ff=resolveFfmpegBin();if(!ff.ok)throw new Error(ff.message);
  execFileSync(ff.bin,['-v','error','-f','lavfi','-i',"aevalsrc='if(between(t,2,4),0,0.5*sin(2*PI*440*t))|-if(between(t,2,4),0,0.5*sin(2*PI*440*t))':s=48000:d=6",'-c:a','pcm_f32le',join(root,'talk.wav')]);
},15000);
afterAll(async()=>{for(const p of [...dirs,root])await rm(p,{recursive:true,force:true});});
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'silence-project-'));dirs.push(directory);
  const asset=await importSequenceAsset(directory,join(root,'talk.wav'),'test.wav'),doc=silenceFixture(180);doc.assets=[asset];
  if(doc.clips[0]!.content.kind==='audio')doc.clips[0]!.content.assetId=asset.id;
  new SequenceStore(directory).save({document:doc,executionId:'initial',expectedSavedRevision:null});
  const sessions=new SequenceService(),state=sessions.open(directory),owner={sessionId:state.sessionId,expectedRevision:0},jobs=new SilenceAnalyses(sessions);
  return {directory,asset,doc,sessions,state,owner,jobs};
}
async function ready(f:Awaited<ReturnType<typeof fixture>>){
  const a=f.jobs.start(f.directory,f.owner,['speech']);
  await vi.waitFor(()=>expect(f.jobs.status(f.directory,a.analysisId,f.owner.sessionId).phase).toBe('completed'),{timeout:10000});
  const p=f.jobs.plan(f.directory,f.owner,a.analysisId,settings);
  await vi.waitFor(()=>expect(f.jobs.planStatus(f.directory,p.planId,f.owner.sessionId).phase).toBe('ready'));
  return {a,p};
}
it('decodes stereo without cancelling opposite phases; isolated audition, concurrent retry, undo and disk reload preserve the source',async()=>{
  const f=await fixture(),before=await readFile(join(f.directory,f.asset.file)),{p}=await ready(f);
  expect(p.ranges).toHaveLength(1);expect(p.ranges[0]!.startFrame).toBeGreaterThanOrEqual(63);expect(p.ranges[0]!.endFrame).toBeLessThanOrEqual(118);
  const preview=f.jobs.preview(f.directory,p.planId,f.owner);expect(preview.id).not.toBe(f.doc.id);expect(preview.sequenceEndFrame).toBeLessThan(180);
  expect(f.sessions.inspect(f.directory,f.owner.sessionId).document).toEqual(f.doc);
  const apply=()=>f.jobs.apply(f.directory,f.owner,p.planId,p.planDigest,'apply-once',new AbortController().signal);
  const results=await Promise.all([apply(),apply()]);expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
  expect(results[0]!.document.cutArchive?.entries).toHaveLength(1);expect(results[0]!.appliedRevision).toBe(1);
  const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+16*60_000);
  try{
    const later=f.jobs.start(f.directory,{...f.owner,expectedRevision:1},['speech']);
    expect(()=>f.jobs.planStatus(f.directory,p.planId,f.owner.sessionId)).toThrow();
    expect((await apply()).replayed).toBe(true);f.jobs.cancel(f.directory,later.analysisId,f.owner.sessionId);
  }finally{clock.mockRestore();}
  const undo=f.sessions.execute(f.directory,{sessionId:f.owner.sessionId,expectedRevision:1,executionId:'undo',command:{type:'undo'}});
  expect(undo.document.clips).toEqual(f.doc.clips);expect((await apply()).document.clips).toEqual(f.doc.clips);
  const redo=f.sessions.execute(f.directory,{sessionId:f.owner.sessionId,expectedRevision:2,executionId:'redo',command:{type:'redo'}});
  f.sessions.save(f.directory,{sessionId:f.owner.sessionId,expectedRevision:3,expectedSavedRevision:0,executionId:'save'});
  expect(new SequenceService().open(f.directory).document).toEqual(redo.document);
  expect(await readFile(join(f.directory,f.asset.file))).toEqual(before);
},20000);
it('rejects foreign ownership, forged digests, stale edits and a cancelled plan without touching history',async()=>{
  const f=await fixture(),{a,p}=await ready(f);
  expect(()=>f.jobs.status(f.directory,a.analysisId,'foreign')).toThrow();
  await expect(f.jobs.apply(f.directory,f.owner,p.planId,'forged','run',new AbortController().signal)).rejects.toThrow();
  f.jobs.cancel(f.directory,a.analysisId,f.owner.sessionId);
  await expect(f.jobs.apply(f.directory,f.owner,p.planId,p.planDigest,'run',new AbortController().signal)).rejects.toThrow();
  expect(f.sessions.inspect(f.directory,f.owner.sessionId).canUndo).toBe(false);
  const next=await ready(f);f.sessions.execute(f.directory,{...f.owner,executionId:'rename',command:{type:'update-clip',clipId:'voice',patch:{name:'manual'}}});
  await expect(f.jobs.apply(f.directory,f.owner,next.p.planId,next.p.planDigest,'stale',new AbortController().signal)).rejects.toThrow(/変わり/);
  expect(f.sessions.inspect(f.directory,f.owner.sessionId).document.clips[0]!.name).toBe('manual');
},20000);
it('reuses a pinned cache, rebuilds corrupt levels and rejects modified source media',async()=>{
  const f=await fixture(),signal=new AbortController().signal;
  const first=await acquireSilenceEnvelope(f.directory,f.asset,0,signal,()=>{}),second=await acquireSilenceEnvelope(f.directory,f.asset,0,signal,()=>{});
  expect(first.envelope.rms).toEqual(second.envelope.rms);expect(first.envelope.rms[100]).toBeGreaterThan(.3);expect(first.envelope.rms[300]).toBe(0);
  first.release();second.release();
  const dir=join(f.directory,'.harness/cache/silence-rms-v1'),file=(await readdir(dir)).find(n=>n.endsWith('.rms'))!;await writeFile(join(dir,file),'corrupt');
  const rebuilt=await acquireSilenceEnvelope(f.directory,f.asset,0,signal,()=>{});expect(rebuilt.envelope.rms).toEqual(first.envelope.rms);rebuilt.release();
  await unlink(join(dir,file));const cancelled=new AbortController();
  const interrupted=acquireSilenceEnvelope(f.directory,f.asset,0,cancelled.signal,()=>cancelled.abort());
  const rejected=expect(interrupted).rejects.toThrow();
  const survivor=await acquireSilenceEnvelope(f.directory,f.asset,0,signal,()=>{});await rejected;
  expect(survivor.envelope.rms).toEqual(first.envelope.rms);survivor.release();
  await writeFile(join(f.directory,f.asset.file),'changed');await expect(acquireSilenceEnvelope(f.directory,f.asset,0,signal,()=>{})).rejects.toThrow();
},20000);

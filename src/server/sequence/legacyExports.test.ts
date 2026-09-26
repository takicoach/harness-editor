import { afterAll,afterEach,beforeAll,expect,it,vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,copyFile,readFile,writeFile,rm,symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SequenceExports } from './exports';
import { resolveFfmpegBin,resolveFfprobeBin } from '../resolveFfmpeg';
import { sequenceContentHash } from './store';
import { serializeSequence } from '../../core/sequence/validate';
import type { SequenceDocument } from '../../core/sequence/model';
import { verifyExportProbe } from './exportVerification';
import { readExportRecord } from './exportRecords';

const document:SequenceDocument={schemaVersion:2,id:'case',name:'以前の出力',revision:2,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:30,
  background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
let media:string,probe:Record<string,unknown>;const roots:string[]=[];
beforeAll(async()=>{
  media=await mkdtemp(join(tmpdir(),'native-legacy-media-'));const ffmpeg=resolveFfmpegBin(),ffprobe=resolveFfprobeBin();
  if(!ffmpeg.ok)throw new Error(ffmpeg.message);if(!ffprobe.ok)throw new Error(ffprobe.message);
  execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=black:size=320x180:rate=30','-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t','1','-vf','setparams=range=limited:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709','-c:v','libx264','-pix_fmt','yuv420p','-color_primaries','bt709','-colorspace','bt709','-color_trc','iec61966-2-1','-color_range','tv','-c:a','aac','-movflags','+faststart',join(media,'output.mp4')]);
  probe=JSON.parse(execFileSync(ffprobe.bin,['-v','error','-show_streams','-show_format','-of','json',join(media,'output.mp4')],{encoding:'utf8'}));
},15000);
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
afterAll(async()=>{await rm(media,{recursive:true,force:true});});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'native-legacy-export-')),id=randomUUID();roots.push(root);
  const directory=join(root,'.harness/exports',id);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'input.json'),serializeSequence(document));await copyFile(join(media,'output.mp4'),join(directory,'output.mp4'));
  const contentHash=sequenceContentHash(document),status={id,projectId:'case',revision:2,contentHash,executionId:'old-start',phase:'complete',completedFrames:30,totalFrames:30,createdAt:new Date().toISOString(),
    downloadUrl:'https://untrusted.invalid/never-follow-this'};
  await writeFile(join(directory,'result.json'),JSON.stringify(status));
  await writeFile(join(directory,'verification.json'),JSON.stringify({revision:2,contentHash,audio:{sampleCount:48000},probe}));
  return {root,directory,id,status};
}
it('lists old UUID results, verifies the actual MP4 on first download, and preserves the original records',async()=>{
  const f=await fixture(),runner=vi.fn(),jobs=new SequenceExports(runner);
  const before=await readFile(join(f.directory,'result.json'),'utf8');
  const page=jobs.page(f.root);expect(page.total).toBe(1);expect(page.jobs[0]).toMatchObject({id:f.id,phase:'complete',historical:true});
  expect(page.jobs[0]?.downloadUrl).toMatch(/^\/api\/sequence\/export\/download\?/);expect(existsSync(join(f.directory,'manifest.json'))).toBe(false);
  expect(readExportRecord(f.root,f.id)).toMatchObject({version:0,request:null,legacy:{resultHash:expect.any(String)}});
  expect(jobs.lookup(f.root,'old-start')?.id).toBe(f.id);
  expect(()=>jobs.start(f.root,'case','http://127.0.0.1',{sessionId:'new',expectedRevision:2,executionId:'old-start'},()=>{throw new Error('should not read session');})).toThrow(/開始要求の記録がありません/);
  const [first,second]=await Promise.all([jobs.download(f.root,f.id),new SequenceExports().download(f.root,f.id)]);
  expect(first).toBe(second);expect(await readFile(first)).toEqual(await readFile(join(media,'output.mp4')));
  const saved=readExportRecord(f.root,f.id);expect(saved.version).toBe(0);expect(saved.request).toBeNull();expect(saved.output?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await readFile(join(f.directory,'result.json'),'utf8')).toBe(before);expect(runner).not.toHaveBeenCalled();
  await writeFile(join(f.directory,'output.mp4'),'replaced');await expect(new SequenceExports().download(f.root,f.id)).rejects.toThrow(/変更/);
});
it('shows an unfinished old job without inventing an execution request or publishing its MP4',async()=>{
  const f=await fixture();await rm(join(f.directory,'result.json'));const jobs=new SequenceExports();
  expect(jobs.page(f.root).jobs[0]).toMatchObject({historical:true,phase:'failed',executionId:null,error:expect.stringContaining('完了記録がありません')});
  expect(jobs.page(f.root).jobs[0]?.downloadUrl).toBeUndefined();await expect(jobs.download(f.root,f.id)).rejects.toThrow(/完了していません/);
  expect(existsSync(join(f.directory,'output.mp4'))).toBe(true);expect(existsSync(join(f.directory,'manifest.json'))).toBe(false);
  // A previous server may still finish; lack of a result is not proof its process is dead.
  await writeFile(join(f.directory,'result.json'),JSON.stringify(f.status));expect(jobs.page(f.root).jobs[0]?.phase).toBe('complete');
});
it.each(['video','input','verification','symlink'] as const)('refuses invalid old %s before publishing a verification baseline',async kind=>{
  const f=await fixture();
  if(kind==='video')await writeFile(join(f.directory,'output.mp4'),'not a video');
  if(kind==='input')await writeFile(join(f.directory,'input.json'),serializeSequence({...document,name:'changed'}));
  if(kind==='verification')await writeFile(join(f.directory,'verification.json'),'{}');
  if(kind==='symlink'){await rm(join(f.directory,'output.mp4'));await symlink(join(media,'output.mp4'),join(f.directory,'output.mp4'));}
  await expect(new SequenceExports().download(f.root,f.id)).rejects.toThrow();expect(existsSync(join(f.directory,'manifest.json'))).toBe(false);
});
it('rejects missing or malformed audio length and extra streams in both old and new output verification',()=>{
  expect(()=>verifyExportProbe(document,probe,48000)).not.toThrow();
  const missing=structuredClone(probe) as {streams:Array<Record<string,unknown>>};delete missing.streams.find(stream=>stream.codec_type==='audio')!.duration_ts;
  expect(()=>verifyExportProbe(document,missing,48000)).toThrow(/音声/);
  const extra=structuredClone(probe) as {streams:Array<Record<string,unknown>>};extra.streams.push({...extra.streams.find(stream=>stream.codec_type==='video')!});
  expect(()=>verifyExportProbe(document,extra,48000)).toThrow(/形式/);
});

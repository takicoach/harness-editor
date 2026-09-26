import {afterEach,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,stat} from 'node:fs/promises';
import {renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {registerSequenceReference} from './references';
import {runSequenceExport} from './exportRunner';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import type {NativeExportStatus} from '../../shared/nativeExport';
import {rational as r} from '../../core/sequence/time';
const render=vi.hoisted(()=>({png:Buffer.alloc(0),close:vi.fn(async()=>{})}));
vi.mock('playwright-core',()=>({chromium:{launch:async()=>({version:()=> 'admission-test-renderer',close:render.close,newPage:async()=>({
 setDefaultTimeout(){},on(){},goto:async()=>{},evaluate:async()=>{},screenshot:async()=>render.png,
 context:()=>({newCDPSession:async()=>({send:async()=>({data:render.png.toString('base64')})})}),
 locator:()=>({elementHandle:async()=>({contentFrame:async()=>({waitForFunction:async()=>{},evaluate:async()=>undefined})})})
})})}}));
afterEach(()=>vi.clearAllMocks());
it.each(['unchanged','missing','same-bytes-new-inode'])('keeps reference admission through encoding: %s',async change=>{
 const directory=await mkdtemp(join(tmpdir(),'native-export-references-')),output=join(directory,'job'),source=join(directory,'tone.wav');
 const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
 try{
  await mkdir(output);execFileSync(ffmpeg.bin,['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1',source]);
  render.png=execFileSync(ffmpeg.bin,['-v','error','-f','lavfi','-i','color=black:size=32x32','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1']);
  const bytes=await readFile(source),asset=await registerSequenceReference(directory,source);
  const document:SequenceDocument={schemaVersion:2,id:'case',name:'参照書き出し',revision:0,fps:r(30),resolution:{width:32,height:32},sequenceEndFrame:3,background:'#000000',assets:[asset],
   tracks:[{id:'audio',kind:'audio',name:'原音',enabled:true}],clips:[{id:'speech',trackId:'audio',name:'原音',startFrame:0,durationFrames:3,clock:{offset:r(0),rate:r(1),duration:r(3)},
    content:{kind:'audio',assetId:asset.id,streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const status:NativeExportStatus={id:'job',projectId:'case',revision:0,contentHash:'test',executionId:null,phase:'queued',completedFrames:0,totalFrames:3,createdAt:new Date().toISOString()};let changed=false;
  const promise=runSequenceExport({plan:new ScenePlan(document),projectDirectory:directory,directory:output,origin:'http://fixture.invalid',status,signal:new AbortController().signal,progress:()=>{
   if(!changed&&change!=='unchanged'&&status.completedFrames===3){changed=true;renameSync(source,source+'.moved');if(change==='same-bytes-new-inode')writeFileSync(source,bytes);}
  }});
  if(change==='unchanged'){await promise;expect((await stat(join(output,'output.mp4'))).size).toBeGreaterThan(0);}
  else{await expect(promise).rejects.toThrow();expect(changed).toBe(true);expect(status.completedFrames).toBe(3);await expect(stat(join(output,'output.mp4'))).rejects.toMatchObject({code:'ENOENT'});}
  await expect(stat(join(output,'output.partial.mp4'))).rejects.toMatchObject({code:'ENOENT'});await expect(stat(join(output,'audio.f32le'))).rejects.toMatchObject({code:'ENOENT'});expect(render.close).toHaveBeenCalledOnce();
 }finally{await rm(directory,{recursive:true,force:true});}
},20000);

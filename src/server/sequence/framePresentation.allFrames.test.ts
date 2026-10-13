import {afterAll,beforeAll,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {createSequenceProject} from './create';
import {SequenceStore} from './store';
import {framePresentationIndex} from './framePresentation';
import {extractFrameNumber,makeFrameNumberVideos,makeOpenGopVideos,type FrameNumberVideos,type OpenGopVideos} from './__fixtures__/frameNumberVideos';

/** 全フレーム: 索引が選ぶフレームの番号と、Task 7 と同じ引数で実際に取り出した絵の焼き込み番号が、すべて一致する（HEAVY。18 素材・約 3,800 回の取り出し）。 */
let media:string,root:string,videos:FrameNumberVideos,openGop:OpenGopVideos,extra:Record<string,string>;
beforeAll(async()=>{
  media=await mkdtemp(join(tmpdir(),'harness-frame-all-media-'));root=await mkdtemp(join(tmpdir(),'harness-frame-all-'));videos=makeFrameNumberVideos(media);openGop=makeOpenGopVideos(media);
  const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  const make=(name:string,args:string[])=>{const file=join(media,name);execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-y',...args,file]);return file;};
  extra={
    mkv:make('remux.mkv',['-i',videos.cfr2997,'-c','copy']),
    mov:make('cut.mov',['-ss','1.5','-i',videos.cfr2997,'-c','copy']),
    negative:make('negative-cut.mp4',['-ss','1.5','-i',videos.cfr2997,'-c','copy','-movflags','+negative_cts_offsets']),
    vfrCut:make('vfr-cut.mp4',['-ss','0.45','-i',videos.vfr,'-c','copy']),
    audioCut:make('audio-cut.mp4',['-ss','2.2','-i',videos.offsetAudio,'-c','copy']),
    ts600:make('ts600-cut.mp4',['-ss','1.51','-i',make('ts600.mp4',['-i',videos.vfr,'-vf','setpts=N/30/TB','-r','30','-c:v','libx264','-g','30','-bf','2','-video_track_timescale','600']),'-c','copy']),
  };
},120000);
afterAll(async()=>{await rm(media,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
it('every frame of every material: the burned-in number is the indexed frame',async()=>{
  // 最初のフレームの番号は、書き出しが最初に出すフレーム（編集開始をまたぐフレーム）。カットは 1.5 秒→44 番、vfr の 0.45 秒→9 番、
  // 音声つきの 2.2 秒（容器の開始 0.47678 秒から）→65 番。時間単位 600 のカットは編集開始 11072/19200 が 44 番（cts 10880〜11520）の途中
  // （編集リストを無視した全フレームの復号で確かめた値。1.51 秒から素直に数えた 45 番ではない）。
  const cases:Array<[string,string,number,0|90,number]>=[['cfr2997',videos.cfr2997,0,0,0],['editList',videos.editList,0,0,44],['vfr',videos.vfr,0,0,0],['twoStreams-0',videos.twoStreams,0,0,0],
    ['twoStreams-1',videos.twoStreams,1,0,1000],['offsetAudio',videos.offsetAudio,0,0,0],['rotated',videos.rotated,0,90,0],['anamorphic',videos.anamorphic,0,0,0],
    ['mkv',extra.mkv!,0,0,0],['mov',extra.mov!,0,0,44],['negative',extra.negative!,0,0,44],['vfrCut',extra.vfrCut!,0,0,9],['audioCut',extra.audioCut!,0,0,65],['ts600',extra.ts600!,0,0,44],
    // 開いた GOP: キーフレーム直前のフレームはキーフレームの後に復号される（先行フレーム）。カットは 2.5 秒＝74 番の途中から
    ['openGop264',openGop.openGop264,0,0,0],['openGop265',openGop.openGop265,0,0,0],['openGop264Cut',openGop.openGop264Cut,0,0,74],['openGop265Cut',openGop.openGop265Cut,0,0,74]];
  const report:string[]=[];
  for(const [name,file,stream,rotation,first] of cases){
    const {id}=await createSequenceProject(root,{name,videoName:'source.mp4',sourcePath:file}),directory=join(root,id);
    const asset=new SequenceStore(directory).load()!.document.assets.find(a=>a.streams.some(s=>s.kind==='video'))!,index=await framePresentationIndex(directory,asset,stream);
    const burned=index.pts.map((_,frame)=>extractFrameNumber(file,index,frame,stream,rotation));
    const wrong=burned.flatMap((value,frame)=>value===first+frame?[]:[`${frame}→${value}`]);
    report.push(`${name}: ${index.pts.length} frames from ${burned[0]}${index.ignoreEditList?' (MP4 timeline)':' (FFmpeg times)'}, mismatches ${wrong.length}${wrong.length?` (${wrong.slice(0,5).join(' ')})`:''}`);
  }
  console.log(report.join('\n'));
  expect(report.filter(line=>!line.endsWith('mismatches 0'))).toEqual([]);
},900000);

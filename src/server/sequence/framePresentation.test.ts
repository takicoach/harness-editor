import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {execFileSync,spawnSync} from 'node:child_process';
import {closeSync,existsSync,openSync} from 'node:fs';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addTime,compareTime,rational as r,type Rational} from '../../core/sequence/time';
import {mp4EditTimeline,mp4SampleTimeline,readMp4Movie} from '../../preview/native/mp4Timeline';
import type * as Mp4Timeline from '../../preview/native/mp4Timeline';
import {videoOnlyMp4Bytes} from '../../preview/native/videoOnlyMp4Bytes';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {createSequenceProject} from './create';
import {SequenceStore} from './store';
import {forgetFramePresentations,frameAtTime,frameExtractionArgs,framePresentationIndex,frameSeekMicroseconds,parseFramePresentation,parseMicroseconds,seekArgument,type FramePresentation} from './framePresentation';
import {extractFrameNumber,keyframeBoundaryFrames,makeFrameNumberVideos,makeOpenGopVideos,type FrameNumberVideos,type OpenGopVideos} from './__fixtures__/frameNumberVideos';

// 試験用の故障の差し込み: 次の 1 回だけ、mp4box で MP4 を読む段（readMp4Movie）か、書き出しの時刻表（mp4SampleTimeline）で例外を投げる
const fault=vi.hoisted(()=>({read:undefined as Error|undefined,timeline:undefined as Error|undefined}));
vi.mock('../../preview/native/mp4Timeline',async importOriginal=>{
  const actual=await importOriginal<typeof Mp4Timeline>();
  return {...actual,
    readMp4Movie:async(...args:Parameters<typeof actual.readMp4Movie>)=>{const error=fault.read;fault.read=undefined;if(error)throw error;return actual.readMp4Movie(...args);},
    mp4SampleTimeline:(...args:Parameters<typeof actual.mp4SampleTimeline>)=>{const error=fault.timeline;fault.timeline=undefined;if(error)throw error;return actual.mp4SampleTimeline(...args);}};
});

const plain=(pts:number[],den:number,decodeFrom=pts.map(()=>0)):FramePresentation=>
  ({version:3,timeBase:{num:1,den},pts,streamTimeBase:{num:1,den},decodePts:[...pts],decodeFrom,startMicroseconds:0,ignoreEditList:false});
describe('presentation index (pure)',()=>{
  it('parses FFprobe csv in decode order, drops edit-list preroll and sorts by presentation time',()=>{
    const index=parseFramePresentation(['packet,-1001,-3003,K_D','packet,0,-2002,___','packet,3003,-1001,___','packet,1001,0,___','packet,2002,1001,___','stream,1/30000','format,0.000000',''].join('\n'));
    expect(index).toEqual({...plain([0,1001,2002,3003],30000),decodeFrom:[-3003,-3003,-3003,-3003]});
    expect(()=>parseFramePresentation('packet,0,0,K__\npacket,0,1,___\nstream,1/30000\nformat,0.000000')).toThrow('重複');
    expect(()=>parseFramePresentation('packet,N/A,0,K__\nstream,1/30000\nformat,0.000000')).toThrow('時刻');
    expect(parseMicroseconds('-0.021333')).toBe(-21333);expect(parseMicroseconds('12.5')).toBe(12_500_000);
  });
  it('decodes each frame from the keyframe before it in decode order, and an open-GOP leading frame from the one before that',()=>{
    // 復号順: A(0) 2 1 B(4) 3 5。3 は B の後に復号されるが B より前に表示される（先行フレーム）ので A から。dts の無い容器はキーフレームの pts。
    const index=parseFramePresentation(['packet,0,-1001,K__','packet,2002,0,___','packet,1001,1001,___','packet,4004,2002,K__','packet,3003,3003,___','packet,5005,N/A,___','stream,1/30000','format,0.000000'].join('\n'));
    expect(index.decodeFrom).toEqual([-1001,-1001,-1001,-1001,2002,2002]);
    expect(parseFramePresentation('packet,0,N/A,K__\npacket,1001,N/A,___\nstream,1/1000\nformat,0.000000').decodeFrom).toEqual([0,0]);
  });
  const index=plain([0,3000,9000,12000],90000);
  it('picks the frame shown at or before the time; before the first → first; after the last → last',()=>{
    // 0.1 秒＝9000 はフレーム 2 の表示時刻ちょうど。5/30 秒は最終フレーム（12000）より後、10 秒は終端を越える。
    expect([r(0),r(1,30),r(2,30),r(3,30),r(1,10),r(5,30),r(10),r(-1,30)].map(time=>frameAtTime(index,time))).toEqual([0,1,1,2,2,3,3,0]);
    expect(frameAtTime({...index,pts:[1500,3000]},r(0))).toBe(0);
  });
  it('seeks (inexactly) to the keyframe decoding starts from, and selects the frame by its exact pts',()=>{
    const ntsc=plain([0,1001,137137],30000,[-2002,-2002,135135]);
    expect(frameSeekMicroseconds(ntsc,2)).toBe(4504500);expect(seekArgument(4504500)).toBe('4.504500');
    expect(frameSeekMicroseconds({...ntsc,startMicroseconds:66733},2)).toBe(4504500-66733);expect(frameSeekMicroseconds(ntsc,0)).toBe(0);expect(seekArgument(0)).toBe('0.000000');
    // MP4: 選ぶのは書き出しの表示時刻（pts）、取り出しは編集リストを無視した生の時刻（decodePts・decodeFrom）
    const cut:FramePresentation={version:3,timeBase:{num:1,den:30000},pts:[0,45,1046],streamTimeBase:{num:1,den:30000},decodePts:[46046,47047,48048],decodeFrom:[0,0,0],startMicroseconds:66733,ignoreEditList:true};
    expect(frameAtTime(cut,r(44,30000))).toBe(0);expect(frameAtTime(cut,r(45,30000))).toBe(1);
    const args=frameExtractionArgs(cut,0,0,72,'out.jpg'),input=args.indexOf('-i');
    expect(args.slice(args.indexOf('-ignore_editlist'),input)).toEqual(['-ignore_editlist','1','-noaccurate_seek','-ss','0.000000','-copyts']);
    expect(args[args.indexOf('-vf')+1]).toMatch(/^trim=end_pts=46047,select=eq\(pts\\,46046\),scale=/);
    expect(frameExtractionArgs(ntsc,1,0,72,'out.jpg')).not.toContain('-ignore_editlist');
  });
});
describe('presentation index from FFprobe',()=>{
  let media:string,root:string,videos:FrameNumberVideos,openGop:OpenGopVideos;
  beforeAll(async()=>{media=await mkdtemp(join(tmpdir(),'harness-frame-index-media-'));root=await mkdtemp(join(tmpdir(),'harness-frame-index-'));videos=makeFrameNumberVideos(media);openGop=makeOpenGopVideos(media);},60000);
  afterAll(async()=>{await rm(media,{recursive:true,force:true});await rm(root,{recursive:true,force:true});});
  const open=async(source:string,name:string)=>{const {id}=await createSequenceProject(root,{name,videoName:'source.mp4',sourcePath:source}),directory=join(root,id);
    return {directory,asset:new SequenceStore(directory).load()!.document.assets.find(a=>a.streams.some(s=>s.kind==='video'))!};};
  it('29.97fps and variable frame rate: exact presentation times, stored on disk and reused',async()=>{
    const ntsc=await open(videos.cfr2997,'ntsc'),index=await framePresentationIndex(ntsc.directory,ntsc.asset,0);
    expect(index.timeBase).toEqual({num:1,den:30000});expect(index.pts).toHaveLength(300);expect(index.pts[137]).toBe(137137);
    const vfr=await open(videos.vfr,'vfr'),variable=await framePresentationIndex(vfr.directory,vfr.asset,0);expect(variable.pts.slice(0,5)).toEqual([0,3000,9000,12000,18000]);
    const file=join(ntsc.directory,'.harness/cache/frames/frames-v1',ntsc.asset.fingerprint,'s0','index.json'),saved=(await stat(file)).mtimeMs;
    forgetFramePresentations();expect(await framePresentationIndex(ntsc.directory,ntsc.asset,0)).toEqual(index);expect((await stat(file)).mtimeMs).toBe(saved);
  },60000);
  it('the second video stream has its own index, and a non-video stream is refused',async()=>{
    const two=await open(videos.twoStreams,'two');expect((await framePresentationIndex(two.directory,two.asset,1)).pts).toHaveLength(120);
    await expect(framePresentationIndex(two.directory,two.asset,7)).rejects.toThrow('映像ストリーム');
  },60000);
  it('an edit list starting inside a frame: that frame is shown first, as in the export, and extraction reaches it',async()=>{
    const cut=await open(videos.editList,'cut'),index=await framePresentationIndex(cut.directory,cut.asset,0);
    // 1.5 秒の編集開始は 44 番の途中。書き出しは 44 番を 0 秒から出し、文書のコマ時刻 k·1001/30000 は 44+k 番。
    expect(index.ignoreEditList).toBe(true);expect([0,1,10].map(k=>extractFrameNumber(videos.editList,index,frameAtTime(index,r(k*1001,30000))))).toEqual([44,45,54]);
  },60000);
  it('an empty edit of 0.5 s with audio: source time counts from the movie start, not from the container start',async()=>{
    const late=await open(videos.offsetAudio,'late'),index=await framePresentationIndex(late.directory,late.asset,0);
    expect([r(3),r(5005,10000)].map(time=>extractFrameNumber(videos.offsetAudio,index,frameAtTime(index,time)))).toEqual([74,0]);
  },60000);
  it('a lossless cut of an open-GOP source (H.264 and HEVC) stays on the export timeline although its first decodable frame is not its earliest',async()=>{
    for(const [name,file] of [['og264',openGop.openGop264Cut],['og265',openGop.openGop265Cut]] as const){
      const cut=await open(file,name),index=await framePresentationIndex(cut.directory,cut.asset,0);
      // 編集開始 2.5 秒は 74 番の途中。FFprobe の時刻に落ちると 75 番から数えて 1 コマ先を選ぶ。
      expect(index.ignoreEditList,name).toBe(true);
      expect([0,1,10].map(k=>extractFrameNumber(file,index,frameAtTime(index,r(k*1001,30000)))),name).toEqual([74,75,84]);
      const frames=keyframeBoundaryFrames(index);expect(frames.map(frame=>extractFrameNumber(file,index,frame)),name).toEqual(frames.map(frame=>74+frame));
    }
  },120000);
  it('stops decoding right after the wanted pts when no frame has it, instead of decoding to the end',async()=>{
    const ntsc=await open(videos.cfr2997,'nomatch'),index=await framePresentationIndex(ntsc.directory,ntsc.asset,0),ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
    const out=join(media,'nomatch.jpg'),args=frameExtractionArgs({...index,decodePts:index.decodePts.map(pts=>pts+1)},1,0,72,out),filter=args.indexOf('-vf')+1;
    args[args.indexOf('-loglevel')+1]='info';args[filter]=`showinfo,${args[filter]}`;   // 復号されてフィルタに入ったフレームを数える
    const fd=openSync(videos.cfr2997,'r');let result;try{result=spawnSync(ffmpeg.bin,args,{stdio:['ignore','pipe','pipe',fd],encoding:'utf8'});}finally{closeSync(fd);}
    const decoded=result.stderr.split('\n').filter(line=>/Parsed_showinfo.*\bn:\s*\d+/.test(line)).length;
    expect(existsSync(out)).toBe(false);expect(decoded).toBeGreaterThan(0);expect(decoded).toBeLessThan(10);   // 300 フレームの素材の 1 番
  },60000);
  it('reads the MP4 with FFprobe times when mp4box fails in any way, but a fault in the timeline code still surfaces',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    try{
      forgetFramePresentations();fault.read=new TypeError('mp4box の内部の誤り');
      const broken=await open(videos.cfr2997,'mp4box-fault'),index=await framePresentationIndex(broken.directory,broken.asset,0);
      expect(index.ignoreEditList).toBe(false);expect(warn.mock.calls.some(call=>String(call).includes('mp4box の内部の誤り'))).toBe(true);
      forgetFramePresentations();fault.timeline=new TypeError('時刻表の誤り');
      const bug=await open(videos.cfr2997,'timeline-fault');await expect(framePresentationIndex(bug.directory,bug.asset,0)).rejects.toThrow('時刻表の誤り');
    }finally{warn.mockRestore();fault.read=fault.timeline=undefined;forgetFramePresentations();}   // 戻した索引を他の試験に残さない
  },60000);
  // 全フレームは framePresentation.allFrames.test.ts（HEAVY）。ここではキーフレームの境目の前後（B フレームの取りこぼしが出る所）を必ず見る。
  it('extracts the indexed frame across every keyframe boundary with the Task 7 arguments',async()=>{
    for(const [name,file,stream,first] of [['ntsc-b',videos.cfr2997,0,0],['cut-b',videos.editList,0,44],['vfr-b',videos.vfr,0,0],['two-b',videos.twoStreams,1,1000],['late-b',videos.offsetAudio,0,0]] as const){
      const project=await open(file,name),index=await framePresentationIndex(project.directory,project.asset,stream),frames=keyframeBoundaryFrames(index);
      expect(frames.length,name).toBeGreaterThanOrEqual(10);
      expect(frames.map(frame=>extractFrameNumber(file,index,frame,stream)),name).toEqual(frames.map(frame=>first+frame));
    }
  },120000);
  it('a container the export cannot open (Matroska) keeps the FFmpeg presentation times',async()=>{
    const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
    const mkv=join(media,'remux.mkv');execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-y','-i',videos.cfr2997,'-c','copy',mkv]);
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    const other=await open(mkv,'mkv'),index=await framePresentationIndex(other.directory,other.asset,0);
    expect(warn.mock.calls.some(call=>String(call[0]).includes('書き出しの復号器が開けない素材'))).toBe(true);warn.mockRestore();   // 戻した理由を残す
    expect(index.ignoreEditList).toBe(false);expect(index.pts).toHaveLength(300);
    // Matroska の時刻はミリ秒に丸められる（299 番は 9977ms で 299·1001/30000 秒より後）ので、フレームの中ほどの時刻で選ぶ
    expect([0,1,137,299].map(k=>frameAtTime(index,r(k*1001+500,30000)))).toEqual([0,1,137,299]);
    const frames=keyframeBoundaryFrames(index);expect(frames.map(frame=>extractFrameNumber(mkv,index,frame))).toEqual(frames);
  },60000);
  /** 書き出しの復号器（Mp4FrameSource.open と acquire）と同じ時刻表・同じ選び方: 表示区間 [pts, pts+duration) に入る標本の生の cts。 */
  const exportTimeline=async(file:string,videoPosition:number)=>{
    const data=await readFile(file),bytes=await videoOnlyMp4Bytes({size:data.length,read:async(start,end)=>data.buffer.slice(data.byteOffset+start,data.byteOffset+end) as ArrayBuffer});
    const {file:mp4,movie}=await readMp4Movie(bytes),track=movie.videoTracks[videoPosition]!;
    const {samples,presentation}=mp4SampleTimeline(mp4.getTrackSamplesInfo(track.id),mp4EditTimeline(track),bytes.size);
    return (time:Rational)=>{const shown=presentation.find(s=>compareTime(s.pts,time)<=0&&compareTime(time,addTime(s.pts,s.duration))<0);return shown&&r(samples[shown.sample]!.sample.cts,track.timescale);};
  };
  it('agrees with the export decoder at every frame time of the document and between them',async()=>{
    for(const [name,file,stream,position] of [['cut2',videos.editList,0,0],['late2',videos.offsetAudio,0,0],['ntsc2',videos.cfr2997,0,0],['vfr2',videos.vfr,0,0],['two2',videos.twoStreams,1,1]] as const){
      const project=await open(file,name),index=await framePresentationIndex(project.directory,project.asset,stream),exported=await exportTimeline(file,position);
      let compared=0;
      for(let k=0;k<330;k++)for(const time of [r(k*1001,30000),r(k*1001+500,30000),r(k,60)]){
        const expected=exported(time);if(!expected)continue;   // 書き出しにコマが無い時刻（先頭の空き・終端の後）は比べない
        const frame=frameAtTime(index,time);compared++;
        expect(compareTime(r(index.decodePts[frame]!*index.streamTimeBase.num,index.streamTimeBase.den),expected),`${name} ${time.num}/${time.den}`).toBe(0);
      }
      expect(compared,name).toBeGreaterThan(200);
    }
  },60000);
  it('rebuilds a corrupt index.json',async()=>{
    forgetFramePresentations();   // 同じ素材の索引が記憶にあるとこの案件には保存されないので、記憶を空にしてから作る
    const ntsc=await open(videos.cfr2997,'corrupt'),index=await framePresentationIndex(ntsc.directory,ntsc.asset,0);
    const file=join(ntsc.directory,'.harness/cache/frames/frames-v1',ntsc.asset.fingerprint,'s0','index.json');
    for(const broken of ['{"version":3,"pts":[',JSON.stringify({...index,pts:[0,0]}),JSON.stringify({...index,decodeFrom:index.decodeFrom.slice(1)})]){
      await writeFile(file,broken);forgetFramePresentations();
      expect(await framePresentationIndex(ntsc.directory,ntsc.asset,0)).toEqual(index);expect(JSON.parse(await readFile(file,'utf8'))).toEqual(index);
    }
  },60000);
});

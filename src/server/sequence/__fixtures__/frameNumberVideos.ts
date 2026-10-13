import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {closeSync,openSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveFfmpegBin} from '../../resolveFfmpeg';
import {frameExtractionArgs,type FramePresentation} from '../framePresentation';

/**
 * テスト専用: 各フレームに自分の番号（表示順・0 始まり）を焼き込んだ映像。drawtext の無い FFmpeg でも作れるよう、
 * 画面上部 1/3 を 12 本の白黒の帯（左から 2^0…2^11 の位）にする（geq の N＝フィルタに入った順のフレーム番号）。
 * 下 2/3 は testsrc2（人が目で番号を読める）。
 */
export const FRAME_NUMBER_BITS=12;
const stripes=(offset=0)=>`geq=lum='if(lt(Y\\,H/3)\\,16+219*mod(floor((N+${offset})/pow(2\\,floor(X*${FRAME_NUMBER_BITS}/W)))\\,2)\\,lum(X\\,Y))':cb='if(lt(Y\\,H/3)\\,128\\,cb(X\\,Y))':cr='if(lt(Y\\,H/3)\\,128\\,cr(X\\,Y))'`;
function bin(){const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);return ffmpeg.bin;}
const run=(args:string[])=>execFileSync(bin(),['-hide_banner','-loglevel','error','-y',...args]);
export interface FrameNumberVideos {cfr2997:string;vfr:string;twoStreams:string;rotated:string;anamorphic:string;editList:string;offsetAudio:string}
export function makeFrameNumberVideos(dir:string):FrameNumberVideos{
  // 29.97fps・10秒（300フレーム）・Bフレームあり・GOP 60
  const cfr2997=join(dir,'cfr2997.mp4');run(['-f','lavfi','-i','testsrc2=s=320x180:r=30000/1001:d=10,format=yuv420p','-vf',stripes(),'-c:v','libx264','-g','60','-bf','2','-pix_fmt','yuv420p',cfr2997]);
  // 表示時刻 0, 1/30, 3/30, 4/30, 6/30 …（間隔が 1/30 と 2/30 で交互）。passthrough でないと mp4 で CFR へ水増しされる
  const vfr=join(dir,'vfr.mp4');run(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=4,format=yuv420p','-vf',`${stripes()},setpts='(N+floor(N/2))/30/TB'`,'-fps_mode','passthrough','-video_track_timescale','90000','-c:v','libx264','-g','30','-bf','2',vfr]);
  // 映像ストリーム 2 本: 0 は番号 N、1 は番号 N+1000（同じ尺・同じ時刻）
  const plain=join(dir,'plain30.mp4'),offset=join(dir,'offset30.mp4');
  run(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=4,format=yuv420p','-vf',stripes(),'-c:v','libx264','-g','30',plain]);
  run(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=4,format=yuv420p','-vf',stripes(1000),'-c:v','libx264','-g','30',offset]);
  const twoStreams=join(dir,'two-streams.mp4');run(['-i',plain,'-i',offset,'-map','0:v','-map','1:v','-c','copy',twoStreams]);
  const rotated=join(dir,'rotated90.mp4');run(['-display_rotation','90','-i',plain,'-c','copy',rotated]);
  // 画素比 2:1（保存 160x180 → 表示 320x180）
  const anamorphic=join(dir,'anamorphic.mp4');run(['-f','lavfi','-i','testsrc2=s=160x180:r=30:d=2,format=yuv420p,setsar=2/1','-vf',stripes(),'-c:v','libx264',anamorphic]);
  // 無変換カット（LosslessCut 等と同じ形）: 編集リストの開始 1.5 秒が 44 番 [1.4681, 1.5015) の途中にある
  const editList=join(dir,'edit-list.mp4');run(['-ss','1.5','-i',cfr2997,'-c','copy',editList]);
  // 音声つき・映像の前に 0.5 秒の空の編集（AAC の先頭は別の編集なので、容器の開始時刻は 0.5 秒にならない）
  const offsetAudio=join(dir,'offset-audio.mp4');run(['-f','lavfi','-i','testsrc2=s=320x180:r=30000/1001:d=10,format=yuv420p','-f','lavfi','-i','sine=f=440:d=10','-vf',stripes(),
    '-c:v','libx264','-g','60','-bf','2','-pix_fmt','yuv420p','-c:a','aac','-output_ts_offset','0.5',offsetAudio]);
  return {cfr2997,vfr,twoStreams,rotated,anamorphic,editList,offsetAudio};
}
/** 開いた GOP（H.264 open-gop・HEVC の CRA）の素材を 2.5 秒で無変換カットしたもの。カットは 60 番のキーフレームから始まり、その直後に
 * 復号できない先行フレーム（58・59 番。表示はキーフレームより前）が並ぶ。編集開始 2.5 秒は 74 番の途中。 */
export interface OpenGopVideos {openGop264:string;openGop265:string;openGop264Cut:string;openGop265Cut:string}
export function makeOpenGopVideos(dir:string):OpenGopVideos{
  const source=['-f','lavfi','-i','testsrc2=s=320x180:r=30000/1001:d=10,format=yuv420p','-vf',stripes(),'-pix_fmt','yuv420p'];
  const openGop264=join(dir,'open-gop-264.mp4');run([...source,'-c:v','libx264','-g','60','-bf','2','-x264-params','open-gop=1',openGop264]);
  const openGop265=join(dir,'open-gop-265.mp4');run([...source,'-c:v','libx265','-x265-params','keyint=60:min-keyint=60:open-gop=1:bframes=2:log-level=none','-tag:v','hvc1',openGop265]);
  const openGop264Cut=join(dir,'open-gop-264-cut.mp4'),openGop265Cut=join(dir,'open-gop-265-cut.mp4');
  run(['-ss','2.5','-i',openGop264,'-c','copy',openGop264Cut]);run(['-ss','2.5','-i',openGop265,'-c','copy',openGop265Cut]);
  return {openGop264,openGop265,openGop264Cut,openGop265Cut};
}
/** JPEG を 8bit グレーの画素へ（PGM 経由。見出しに幅・高さが入る）。 */
export function readGray(jpeg:Buffer):{width:number;height:number;pixels:Buffer}{
  const pgm=execFileSync(bin(),['-hide_banner','-loglevel','error','-f','jpeg_pipe','-i','pipe:0','-f','image2pipe','-c:v','pgm','-pix_fmt','gray','pipe:1'],{input:jpeg});
  const header=/^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(pgm.subarray(0,32).toString('latin1'));if(!header)throw new Error('PGM の見出しを読めません');
  const width=Number(header[1]),height=Number(header[2]);return {width,height,pixels:pgm.subarray(header[0].length,header[0].length+width*height)};
}
/** 焼き込み番号を読む。rotation 90 は帯が左 1/3 に縦に並び、下から 2^0。 */
export function readFrameNumber(jpeg:Buffer,rotation:0|90=0):number{
  const {width,height,pixels}=readGray(jpeg);let value=0;
  for(let bit=0;bit<FRAME_NUMBER_BITS;bit++){
    const t=(bit+.5)/FRAME_NUMBER_BITS,x=rotation===0?Math.floor(t*width):Math.floor(width/6),y=rotation===0?Math.floor(height/6):Math.floor((1-t)*height);
    if(pixels[y*width+x]!>128)value|=1<<bit;
  }
  return value;
}
/** Task 7 と同じ引数（frameExtractionArgs。素材は fd 3 で渡す）で 1 コマを取り出し、焼き込み番号を読む。 */
export function extractFrameNumber(file:string,index:FramePresentation,frame:number,streamIndex=0,rotation:0|90=0):number{
  const output=join(tmpdir(),`harness-frame-${randomUUID()}.jpg`),fd=openSync(file,'r');
  try{execFileSync(bin(),frameExtractionArgs(index,frame,streamIndex,72,output),{stdio:['ignore','pipe','pipe',fd]});return readFrameNumber(readFileSync(output),rotation);}
  finally{closeSync(fd);rmSync(output,{force:true});}
}
/** キーフレームの境目（復号の起点が変わる所）の前 2 フレームと後 2 フレーム、最初と最後。 */
export function keyframeBoundaryFrames(index:FramePresentation):number[]{
  const last=index.pts.length-1,frames=new Set([0,last]);
  for(let i=1;i<=last;i++)if(index.decodeFrom[i]!==index.decodeFrom[i-1])for(let d=-2;d<=1;d++)frames.add(Math.min(last,Math.max(0,i+d)));
  return [...frames].sort((a,b)=>a-b);
}

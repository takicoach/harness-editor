import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveFfmpegBin} from '../../resolveFfmpeg';

/** テスト専用の合成動画（実案件は読まない）。色と音の高さで素材を見分ける。すべて 160x90。 */
export interface VideoSamples {dir:string;first:string;second60:string;third25:string;silent:string;rotated:string;broken:string}
export function makeVideoSamples(dir:string):VideoSamples{
  const bin=resolveFfmpegBin();if(!bin.ok)throw new Error(bin.message);
  const at=(name:string)=>join(dir,name),run=(args:string[])=>execFileSync(bin.bin,['-hide_banner','-loglevel','error','-y',...args]);
  const clip=(name:string,color:string,rate:string,seconds:number,tone?:number)=>run(['-f','lavfi','-i',`color=c=${color}:size=160x90:rate=${rate}`,
    ...(tone?['-f','lavfi','-i',`sine=frequency=${tone}:sample_rate=48000`]:[]),'-t',String(seconds),'-c:v','libx264','-pix_fmt','yuv420p',...(tone?['-c:a','aac','-shortest']:[]),at(name)]);
  clip('first.mp4','red','30',1,440);clip('second-60.mp4','green','60',2,660);clip('third-25.mp4','blue','25',1,880);clip('silent.mp4','yellow','30',1);
  run(['-display_rotation','90','-i',at('first.mp4'),'-c','copy',at('rotated.mp4')]);
  writeFileSync(at('broken.mp4'),'not a video');
  return {dir,first:at('first.mp4'),second60:at('second-60.mp4'),third25:at('third-25.mp4'),silent:at('silent.mp4'),rotated:at('rotated.mp4'),broken:at('broken.mp4')};
}

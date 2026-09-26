import { afterEach,expect,it } from 'vitest';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';import {join} from 'node:path';
import {installSpeed,isSpeedInstalled} from './installSpeed';import {installTransition,isTransitionInstalled} from './installTransition';
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it.each([[installSpeed,installTransition],[installTransition,installSpeed]])('preserves speed and transitions for either install order',(first,second)=>{
 const dir=mkdtempSync(join(tmpdir(),'native-order-'));dirs.push(dir);mkdirSync(join(dir,'src/Transition'),{recursive:true});writeFileSync(join(dir,'src/videoConfig.ts'),"export const VIDEO_FILE='main.mp4';export const FPS=30;export const DURATION_FRAMES=300;export const FORMAT='youtube';export const RESOLUTION={width:640,height:360};");
 const speed='export const MAIN_SPEED=1.5; export const SEGMENT_SPEEDS={7:2};',transitions='export const transitionData=[{id:3,at:90,kind:"crossfade",durationFrames:12}];';
 writeFileSync(join(dir,'src/speedData.ts'),speed);writeFileSync(join(dir,'src/Transition/transitionData.ts'),transitions);
 first(dir);second(dir);first(dir);second(dir);
 expect(readFileSync(join(dir,'src/speedData.ts'),'utf8')).toBe(speed);expect(readFileSync(join(dir,'src/Transition/transitionData.ts'),'utf8')).toBe(transitions);
 expect(isSpeedInstalled(dir)&&isTransitionInstalled(dir)).toBe(true);expect(existsSync(join(dir,'src/Root.tsx'))).toBe(false);expect(existsSync(join(dir,'src/cutData.ts'))).toBe(false);
});

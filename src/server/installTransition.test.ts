import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTransition, isTransitionInstalled } from './installTransition';
const dirs:string[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'native-transition-'));dirs.push(dir);mkdirSync(join(dir,'src/Transition'),{recursive:true});writeFileSync(join(dir,'src/videoConfig.ts'),"export const VIDEO_FILE='main.mp4';export const FPS=30;export const DURATION_FRAMES=300;export const FORMAT='youtube';export const RESOLUTION={width:640,height:360};");return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('preserves existing data bytes and custom runtime code while migrating the legacy marker',()=>{
 const dir=fixture(),data="export const transitionData=[]; /* user data */ export const CUSTOM='keep';";writeFileSync(join(dir,'src/Transition/transitionData.ts'),data);
 writeFileSync(join(dir,'src/Transition/transition.json'),JSON.stringify({feature:'transition',version:'old'}));
 const files=['src/MainVideo.tsx','src/Root.tsx','package.json','src/MainVideo.original.bak.tsx','src/Transition/custom.tsx'];
 for(const p of files)writeFileSync(join(dir,p),'custom '+p);
 expect(isTransitionInstalled(dir)).toBe(false);expect(installTransition(dir).installed).toBe(true);expect(isTransitionInstalled(dir)).toBe(true);
 expect(readFileSync(join(dir,'src/Transition/transitionData.ts'),'utf8')).toBe(data);
 for(const p of files)expect(readFileSync(join(dir,p),'utf8')).toBe('custom '+p);
 installTransition(dir);expect(readFileSync(join(dir,'src/Transition/transitionData.ts'),'utf8')).toBe(data);
});
it('rejects damaged data without blessing the marker',()=>{const dir=fixture();writeFileSync(join(dir,'src/Transition/transitionData.ts'),'export const broken = ;');expect(()=>installTransition(dir)).toThrow();expect(isTransitionInstalled(dir)).toBe(false);expect(existsSync(join(dir,'src/Transition/transition.json'))).toBe(false);});
it('rejects missing configuration before writing feature data',()=>{const dir=fixture();rmSync(join(dir,'src/videoConfig.ts'));expect(()=>installTransition(dir)).toThrow();expect(existsSync(join(dir,'src/Transition/transition.json'))).toBe(false);});
it('never requests package installation for native transitions',()=>{expect(installTransition(fixture()).needsInstall).toBe(false);});

import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBgm } from './installBgm';
import { installVideoInsert } from './installVideoInsert';
import { installSpeed } from './installSpeed';
import { installTransition } from './installTransition';
import { readNativeDataPackState } from './nativeDataPacks';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
it.each([['bgm',installBgm],['videoInsert',installVideoInsert],['speed',installSpeed],['transition',installTransition]] as const)('%s installs without Root/MainVideo/cut anchors and preserves custom runtime sources', (id,install)=>{
 const dir=mkdtempSync(join(tmpdir(),'native-install-'));dirs.push(dir);mkdirSync(join(dir,'src'));
 writeFileSync(join(dir,'src/videoConfig.ts'),"export const VIDEO_FILE='main.mp4';export const FPS=30;export const DURATION_FRAMES=300;export const FORMAT='youtube';export const RESOLUTION={width:640,height:360};");
 expect(install(dir).installed).toBe(true);expect(readNativeDataPackState(id,dir).status).toBe('ready');
 const untouched=['src/MainVideo.tsx','src/Root.tsx','package.json','src/MainVideo.original.bak.tsx'];
 for(const p of untouched){expect(existsSync(join(dir,p))).toBe(false);writeFileSync(join(dir,p),'custom unparseable source '+p);}
 install(dir);
 for(const p of untouched)expect(readFileSync(join(dir,p),'utf8')).toBe('custom unparseable source '+p);
});

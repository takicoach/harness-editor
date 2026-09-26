import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installVideoInsert, isVideoInsertInstalled } from './installVideoInsert';
const dirs:string[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'native-videoInsert-'));dirs.push(dir);mkdirSync(join(dir,'src/InsertVideo'),{recursive:true});writeFileSync(join(dir,'src/videoConfig.ts'),"export const VIDEO_FILE='main.mp4';export const FPS=30;export const DURATION_FRAMES=300;export const FORMAT='youtube';export const RESOLUTION={width:640,height:360};");return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
it('preserves existing data bytes and custom runtime code while migrating the legacy marker',()=>{
 const dir=fixture(),data="export const insertVideoData=[]; /* user data */ export const CUSTOM='keep';";writeFileSync(join(dir,'src/InsertVideo/insertVideoData.ts'),data);
 writeFileSync(join(dir,'src/InsertVideo/insert-video.json'),JSON.stringify({feature:'insert-video',version:'old'}));
 const files=['src/MainVideo.tsx','src/Root.tsx','package.json','src/MainVideo.original.bak.tsx','src/InsertVideo/custom.tsx'];
 for(const p of files)writeFileSync(join(dir,p),'custom '+p);
 expect(isVideoInsertInstalled(dir)).toBe(false);expect(installVideoInsert(dir).installed).toBe(true);expect(isVideoInsertInstalled(dir)).toBe(true);
 expect(readFileSync(join(dir,'src/InsertVideo/insertVideoData.ts'),'utf8')).toBe(data);
 for(const p of files)expect(readFileSync(join(dir,p),'utf8')).toBe('custom '+p);
 installVideoInsert(dir);expect(readFileSync(join(dir,'src/InsertVideo/insertVideoData.ts'),'utf8')).toBe(data);
});
it('rejects damaged data without blessing the marker',()=>{const dir=fixture();writeFileSync(join(dir,'src/InsertVideo/insertVideoData.ts'),'export const broken = ;');expect(()=>installVideoInsert(dir)).toThrow();expect(isVideoInsertInstalled(dir)).toBe(false);expect(existsSync(join(dir,'src/InsertVideo/insert-video.json'))).toBe(false);});
it('rejects missing configuration before writing feature data',()=>{const dir=fixture();rmSync(join(dir,'src/videoConfig.ts'));expect(()=>installVideoInsert(dir)).toThrow();expect(existsSync(join(dir,'src/InsertVideo/insert-video.json'))).toBe(false);});

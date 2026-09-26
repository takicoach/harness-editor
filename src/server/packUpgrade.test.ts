import { afterEach,expect,it } from 'vitest';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';import {join,dirname} from 'node:path';
import {PACK_DESCRIPTORS,findDescriptor,payloadHash,currentPackVersion,isPackInstalled,isPackStale,checkStalePacks,upgradePack,upgradePacks} from './packUpgrade';
import {nativeDataPackVersion,isNativeDataPackId,readNativeDataPackState} from './nativeDataPacks';
const dirs:string[]=[];const config="export const VIDEO_FILE='main.mp4';export const FPS=30;export const DURATION_FRAMES=300;export const FORMAT='youtube';export const RESOLUTION={width:640,height:360};";
function fixture(){const d=mkdtempSync(join(tmpdir(),'native-upgrade-'));dirs.push(d);mkdirSync(join(d,'src'));writeFileSync(join(d,'src/videoConfig.ts'),config);return d;}
function put(dir:string,path:string,source:string){mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),source);}
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const packs=[['bgm','bgm-track','bgmData.ts','export const bgmData=[];'],['videoInsert','insert-video','insertVideoData.ts','export const insertVideoData=[];'],['speed','speed','../speedData.ts','export const MAIN_SPEED=2;export const SEGMENT_SPEEDS={7:1.5};'],['transition','transition','transitionData.ts','export const transitionData=[];'],['shape','insert-shape','shapeData.ts','export const shapeData=[];'],['mainLayout','mainLayout','../mainLayoutData.ts','export const MAIN_LAYOUT={scale:1.2};']] as const;
it.each(packs)('%s upgrades legacy markers without copying runtime payload or changing existing data',(id,feature,file,source)=>{
 const dir=fixture(),d=findDescriptor(id),data=join('src',d.packDir,file),mp=join('src',d.packDir,d.markerName);put(dir,data,source);put(dir,mp,JSON.stringify({feature,version:currentPackVersion(id)}));
 const protectedFiles=['src/MainVideo.tsx','src/Root.tsx','package.json','src/MainVideo.original.bak.tsx',`src/${d.packDir}/custom.tsx`];for(const path of protectedFiles)put(dir,path,'custom '+path);
 expect(isPackInstalled(d,dir)).toBe(true);expect(isPackStale(d,dir)).toBe(true);expect(checkStalePacks(dir)).toContain(id);
 expect(upgradePacks(dir,[id]).upgraded).toEqual([id]);expect(isPackStale(d,dir)).toBe(false);expect(readNativeDataPackState(id,dir).status).toBe('ready');
 const saved=readFileSync(join(dir,data),'utf8');expect(saved.startsWith(source)).toBe(true);if(id!=='mainLayout')expect(saved).toBe(source);
 for(const path of protectedFiles)expect(readFileSync(join(dir,path),'utf8')).toBe('custom '+path);
 expect(existsSync(join(dir,'src',d.packDir,'index.ts'))).toBe(false);
});
it('versions of native data packs do not read old runtime payload directories',()=>{
 for(const d of PACK_DESCRIPTORS.filter(d=>isNativeDataPackId(d.id))){expect(d.payloadDir).toBeUndefined();expect(payloadHash({...d,payloadDir:'/unavailable/old-runtime'})).toBe(currentPackVersion(d.id));if(isNativeDataPackId(d.id))expect(currentPackVersion(d.id)).toBe(nativeDataPackVersion(d.id));}
});
it('offers repair for broken markers but never marks broken data current',()=>{
 const dir=fixture(),d=findDescriptor('bgm');put(dir,'src/Bgm/bgm-track.json','{broken');put(dir,'src/Bgm/bgmData.ts','export const bgmData="bad";');expect(isPackInstalled(d,dir)).toBe(false);expect(checkStalePacks(dir)).toContain('bgm');expect(()=>upgradePacks(dir,['bgm'])).toThrow();expect(isPackStale(d,dir)).toBe(true);expect(readFileSync(join(dir,'src/Bgm/bgmData.ts'),'utf8')).toBe('export const bgmData="bad";');
 put(dir,'src/Bgm/bgmData.ts','export const bgmData=[];');upgradePacks(dir,['bgm']);expect(isPackStale(d,dir)).toBe(false);
});
it('keeps real telop component replacement and its source-based version while preserving data',()=>{
 const dir=fixture(),d=findDescriptor('telopPack');put(dir,`src/${d.packDir}/${d.markerName}`,JSON.stringify({feature:'telop-pack',version:'old'}));put(dir,`src/${d.packDir}/telopData.ts`,'export const telopData=[]; // user');put(dir,`src/${d.packDir}/Telop.tsx`,'old component');
 upgradePack(d,dir);expect(readFileSync(join(dir,'src',d.packDir,'Telop.tsx'),'utf8')).toBe(readFileSync(join(d.payloadDir!,'Telop.tsx'),'utf8'));expect(readFileSync(join(dir,'src',d.packDir,'telopData.ts'),'utf8')).toBe('export const telopData=[]; // user');expect(isPackStale(d,dir)).toBe(false);
});

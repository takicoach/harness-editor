import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import ts from 'typescript';
import { installNativeDataPack, isNativeDataPackInstalled, readNativeDataPackState, nativeDataPackVersion } from './nativeDataPacks';
import { evalDataModule } from '../core/dataModule';
import { serializeInsertVideoData } from '../core/insertVideoData';
import { loadProjectFromDir } from './loadProjectFiles';
const fault=vi.hoisted(()=>({rename:false,marker:false}));
vi.mock('node:fs',async load=>{const fs=await load<typeof import('node:fs')>();return {...fs,renameSync:(from:string,to:string)=>{if((fault.rename&&to.endsWith('speedData.ts'))||(fault.marker&&to.endsWith('speed.json')))throw new Error('simulated disk rename failure');return fs.renameSync(from,to);}};});
const dirs:string[]=[];
const config="export const VIDEO_FILE='main.mp4';export const FPS=30;export const DURATION_FRAMES=300;export const FORMAT='youtube';export const RESOLUTION={width:640,height:360};";
const defs=[['bgm','Bgm/bgm-track.json','Bgm/bgmData.ts','bgmData'],['videoInsert','InsertVideo/insert-video.json','InsertVideo/insertVideoData.ts','insertVideoData'],['transition','Transition/transition.json','Transition/transitionData.ts','transitionData'],['shape','InsertShape/insert-shape.json','InsertShape/shapeData.ts','shapeData'],['speed','Speed/speed.json','speedData.ts','MAIN_SPEED'],['mainLayout','MainLayout/main-layout.json','mainLayoutData.ts','MAIN_LAYOUT']] as const;
function fixture(){const d=mkdtempSync(join(tmpdir(),'native-pack-'));dirs.push(d);mkdirSync(join(d,'src'));writeFileSync(join(d,'src/videoConfig.ts'),config);return d;}
function put(dir:string,path:string,source:string){mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),source);}
afterEach(()=>{fault.rename=false;fault.marker=false;for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
it.each(defs)('%s creates only missing data and a strict native marker, then is idempotent',(id,mp,data)=>{
 const dir=fixture();installNativeDataPack(id,dir);expect(isNativeDataPackInstalled(id,dir)).toBe(true);
 const marker=readFileSync(join(dir,'src',mp),'utf8'),source=readFileSync(join(dir,'src',data),'utf8');
 expect(JSON.parse(marker)).toEqual({runtime:'harness-native',schemaVersion:1,feature:id,version:nativeDataPackVersion(id)});
 installNativeDataPack(id,dir);expect(readFileSync(join(dir,'src',data),'utf8')).toBe(source);expect(readFileSync(join(dir,'src',mp),'utf8')).toBe(marker);
 for(const file of ['MainVideo.tsx','Root.tsx','MainVideo.original.bak.tsx'])expect(existsSync(join(dir,'src',file))).toBe(false);
 expect(existsSync(join(dir,'package.json'))).toBe(false);
});
it.each(defs)('%s rejects malformed existing data before writing a marker',(id,mp,data)=>{
 const dir=fixture(),source='export const broken = ;';put(dir,'src/'+data,source);
 expect(()=>installNativeDataPack(id,dir)).toThrow('準備できません');expect(readFileSync(join(dir,'src',data),'utf8')).toBe(source);expect(existsSync(join(dir,'src',mp))).toBe(false);
});
it('preserves speed expressions/custom exports and appends only the absent export',()=>{
 const dir=fixture(),source='const rate = 1.5; export const MAIN_SPEED = rate; export const MY_SETTING = "keep"; // mine';put(dir,'src/speedData.ts',source);
 installNativeDataPack('speed',dir);const saved=readFileSync(join(dir,'src/speedData.ts'),'utf8');expect(saved.startsWith(source)).toBe(true);expect(evalDataModule(saved)).toMatchObject({MAIN_SPEED:1.5,SEGMENT_SPEEDS:{},MY_SETTING:'keep'});
});
it('preserves every existing layout export and appends defaults without normalizing the original source',()=>{
 const dir=fixture(),source='export const MAIN_LAYOUT={scale:1.2,position:{x:.2,y:-.3}}; export const MY_LAYOUT="keep";';put(dir,'src/mainLayoutData.ts',source);
 installNativeDataPack('mainLayout',dir);const saved=readFileSync(join(dir,'src/mainLayoutData.ts'),'utf8');expect(saved.startsWith(source)).toBe(true);expect(evalDataModule(saved)).toMatchObject({MAIN_LAYOUT:{scale:1.2,position:{x:.2,y:-.3}},MY_LAYOUT:'keep',SEGMENT_LAYOUTS:{},LAYOUT_KEYFRAMES:[]});
});
it.each(['export const MAIN_SPEED="fast";','export const MAIN_SPEED=NaN;','export const MAIN_SPEED=1; export const SEGMENT_SPEEDS={1:"fast"};'])('rejects invalid speed values instead of resetting to defaults: %s',source=>{
 const dir=fixture();put(dir,'src/speedData.ts',source);expect(()=>installNativeDataPack('speed',dir)).toThrow();expect(readFileSync(join(dir,'src/speedData.ts'),'utf8')).toBe(source);expect(isNativeDataPackInstalled('speed',dir)).toBe(false);
});
it.each([config+' export const broken = ;',config.replace('FPS=30','FPS=0'),config.replace('width:640','width:-1'),config.replace('DURATION_FRAMES=300','DURATION_FRAMES=NaN'),"export const VIDEO_FILE='main.mp4';"])('rejects invalid config without Root/MainVideo fallback',source=>{
 const dir=fixture();put(dir,'src/videoConfig.ts',source);expect(()=>installNativeDataPack('bgm',dir)).toThrow();expect(existsSync(join(dir,'src/Bgm/bgm-track.json'))).toBe(false);
});
it('does not bless partial, wrong-feature, extra-key or invalid-data native markers',()=>{
 const dir=fixture();installNativeDataPack('bgm',dir);const mp='src/Bgm/bgm-track.json',valid=JSON.parse(readFileSync(join(dir,mp),'utf8'));
 for(const marker of [{runtime:'harness-native'},{...valid,feature:'shape'},{...valid,extra:true},{...valid,schemaVersion:2}]){put(dir,mp,JSON.stringify(marker));expect(readNativeDataPackState('bgm',dir).status).toBe('invalid');}
 put(dir,mp,JSON.stringify({...valid,version:'old'}));expect(readNativeDataPackState('bgm',dir).status).toBe('stale');
 put(dir,mp,JSON.stringify(valid));put(dir,'src/Bgm/bgmData.ts','export const bgmData="broken";');expect(isNativeDataPackInstalled('bgm',dir)).toBe(false);
});
it('retains existing native source prefix and removes current marker on a rename failure',()=>{
 const dir=fixture();installNativeDataPack('speed',dir);const source='export const MAIN_SPEED=2; export const CUSTOM="unchanged";';put(dir,'src/speedData.ts',source);
 fault.rename=true;expect(()=>installNativeDataPack('speed',dir)).toThrow('simulated disk rename failure');fault.rename=false;
 expect(readFileSync(join(dir,'src/speedData.ts'),'utf8')).toBe(source);expect(existsSync(join(dir,'src/Speed/speed.json'))).toBe(false);expect(isNativeDataPackInstalled('speed',dir)).toBe(false);
 installNativeDataPack('speed',dir);expect(readFileSync(join(dir,'src/speedData.ts'),'utf8').startsWith(source)).toBe(true);expect(isNativeDataPackInstalled('speed',dir)).toBe(true);
});
it('keeps FPS-based inserted data and creates only a missing type declaration that accepts all serialized fields',()=>{
 const dir=fixture(),source="import type { VideoInsert } from './types'; import { FPS } from '../videoConfig'; export const insertVideoData:VideoInsert[]=[{id:1,startFrame:0,endFrame:FPS,file:'insert.mp4',sourceInFrame:0}];";
 put(dir,'src/InsertVideo/insertVideoData.ts',source);installNativeDataPack('videoInsert',dir);expect(readFileSync(join(dir,'src/InsertVideo/insertVideoData.ts'),'utf8')).toBe(source);
 const data=serializeInsertVideoData(source,[{id:1,startFrame:0,endFrame:30,file:'insert.mp4',sourceInFrame:4,position:{x:.1,y:.2},scale:1.2,playbackRate:1.5,enter:{kind:'slideIn',frames:3,direction:'up'},exit:{kind:'fade',frames:2}}])!;
 put(dir,'src/InsertVideo/insertVideoData.ts',data);
 const program=ts.createProgram([join(dir,'src/InsertVideo/insertVideoData.ts')],{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,moduleResolution:ts.ModuleResolutionKind.Bundler,module:ts.ModuleKind.ESNext});
 expect(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,' '))).toEqual([]);
 expect(existsSync(join(dir,'src/InsertVideo/InsertVideo.tsx'))).toBe(false);expect(existsSync(join(dir,'src/InsertVideo/types.d.ts'))).toBe(true);
});

it('does not write new data through an external directory link',()=>{
 const dir=fixture(),outside=fixture();symlinkSync(join(outside,'src'),join(dir,'src/Bgm'),'dir');
 expect(()=>installNativeDataPack('bgm',dir)).toThrow('リンク');expect(existsSync(join(outside,'src/bgmData.ts'))).toBe(false);expect(existsSync(join(outside,'src/bgm-track.json'))).toBe(false);
});
it('repairs missing known type declarations but never replaces an existing declaration',()=>{
 const dir=fixture(),data="import type {BgmClip} from './types';export const bgmData:BgmClip[]=[];";put(dir,'src/Bgm/bgmData.ts',data);installNativeDataPack('bgm',dir);
 rmSync(join(dir,'src/Bgm/types.d.ts'));expect(readNativeDataPackState('bgm',dir).status).toBe('invalid');installNativeDataPack('bgm',dir);expect(isNativeDataPackInstalled('bgm',dir)).toBe(true);
 put(dir,'src/Bgm/types.d.ts','export interface BgmClip {custom:true}');installNativeDataPack('bgm',dir);expect(readFileSync(join(dir,'src/Bgm/types.d.ts'),'utf8')).toBe('export interface BgmClip {custom:true}');
});

it('does not advertise a completed install if marker commit fails after preserving the augmented data',()=>{
 const dir=fixture();installNativeDataPack('speed',dir);const source='export const MAIN_SPEED=1.5; export const USER_VALUE="retained";';put(dir,'src/speedData.ts',source);
 fault.marker=true;expect(()=>installNativeDataPack('speed',dir)).toThrow('rename failure');fault.marker=false;
 const saved=readFileSync(join(dir,'src/speedData.ts'),'utf8');expect(saved.startsWith(source)).toBe(true);expect(evalDataModule(saved)).toMatchObject({MAIN_SPEED:1.5,USER_VALUE:'retained',SEGMENT_SPEEDS:{}});expect(isNativeDataPackInstalled('speed',dir)).toBe(false);expect(existsSync(join(dir,'src/Speed/speed.json'))).toBe(false);
 installNativeDataPack('speed',dir);expect(readFileSync(join(dir,'src/speedData.ts'),'utf8')).toBe(saved);expect(isNativeDataPackInstalled('speed',dir)).toBe(true);
});

it.each([
 ['mainLayout','mainLayoutData.ts','export const MAIN_LAYOUT={scale:"bad"};'],
 ['mainLayout','mainLayoutData.ts','export const MAIN_LAYOUT={position:{x:"bad",y:0}};'],
 ['mainLayout','mainLayoutData.ts','export const SEGMENT_LAYOUTS={1:{rotation:"bad"}};'],
 ['mainLayout','mainLayoutData.ts','export const COLOR_GRADE={brightness:"bad"};'],
 ['mainLayout','mainLayoutData.ts','export const COLOR_GRADE={wheels:{lift:{x:"bad"}}};'],
 ['mainLayout','mainLayoutData.ts','export const SEGMENT_LAYOUTS={1:{motion:{preset:"custom",from:{scale:"bad"}}}};'],
 ['mainLayout','mainLayoutData.ts','export const LAYOUT_KEYFRAMES=[{originalFrame:0,x:0,y:0,scale:"bad",rotation:0}];'],
 ['bgm','Bgm/bgmData.ts','export const bgmData=[{id:1,startFrame:0,endFrame:30,file:"bgm.wav",volume:"bad"}];'],
 ['bgm','Bgm/bgmData.ts','export const bgmData=[{id:1,startFrame:0,endFrame:30,file:"bgm.wav",ducking:{gain:"bad",attackFrames:1,releaseFrames:1,regions:[]}}];'],
 ['shape','InsertShape/shapeData.ts','export const shapeData=[{id:1,startFrame:0,endFrame:30,kind:"rect",x1:0,y1:0,x2:1,y2:1,color:123,thickness:"thin"}];'],
 ['shape','InsertShape/shapeData.ts','export const shapeData=[{id:1,startFrame:0,endFrame:30,kind:"rect",x1:0,y1:0,x2:1,y2:1,color:"#fff",thickness:"unknown"}];'],
 ['videoInsert','InsertVideo/insertVideoData.ts','export const insertVideoData=[{id:1,startFrame:0,endFrame:30,file:"a.mp4"}];'],
 ['videoInsert','InsertVideo/insertVideoData.ts','export const insertVideoData=[{id:1,startFrame:0,endFrame:30,file:"a.mp4",sourceInFrame:0,enter:{kind:"fade",frames:"bad"}}];'],
 ['transition','Transition/transitionData.ts','export const transitionData=[{id:1,at:0,kind:"slide",durationFrames:12,direction:"diagonal"}];'],
] as const)('rejects malformed known fields without modifying the existing %s source',(id,path,source)=>{
 const dir=fixture();put(dir,'src/'+path,source);expect(()=>installNativeDataPack(id,dir)).toThrow();expect(readFileSync(join(dir,'src',path),'utf8')).toBe(source);expect(isNativeDataPackInstalled(id,dir)).toBe(false);
});
it('preserves finite clamped layout values and unknown exports without normalizing them',()=>{
 const dir=fixture(),source='export const MAIN_LAYOUT={position:{x:99,y:-99},scale:99,rotation:900};export const COLOR_GRADE={brightness:300};export const CUSTOM={tag:"keep"};';put(dir,'src/mainLayoutData.ts',source);installNativeDataPack('mainLayout',dir);expect(readFileSync(join(dir,'src/mainLayoutData.ts'),'utf8').startsWith(source)).toBe(true);expect(isNativeDataPackInstalled('mainLayout',dir)).toBe(true);
});

it('preserves finite speed values for the existing parser clamp instead of rewriting them at install',()=>{
 const dir=fixture(),source='export const MAIN_SPEED=99;export const SEGMENT_SPEEDS={1:-2};';put(dir,'src/speedData.ts',source);installNativeDataPack('speed',dir);expect(readFileSync(join(dir,'src/speedData.ts'),'utf8')).toBe(source);expect(isNativeDataPackInstalled('speed',dir)).toBe(true);
});

it.each([
 ['speed','speedData.ts',"./videoConfig",'export const MAIN_SPEED=FPS/15;'],
 ['mainLayout','mainLayoutData.ts',"./videoConfig",'export const MAIN_LAYOUT={scale:FPS/15};'],
 ['bgm','Bgm/bgmData.ts',"../videoConfig",'export const bgmData=[{id:1,startFrame:0,endFrame:FPS*1,file:"x.wav",volume:0.4}];'],
 ['shape','InsertShape/shapeData.ts',"../videoConfig",'export const shapeData=[{id:1,startFrame:0,endFrame:FPS*1,kind:"rect",x1:0,y1:0,x2:1,y2:1,color:"#fff",thickness:"thin"}];'],
 ['transition','Transition/transitionData.ts',"../videoConfig",'export const transitionData=[{id:1,at:"head",kind:"fadeBlack",durationFrames:FPS*1}];'],
] as const)('does not certify FPS-dependent %s data that the actual project parser cannot read',(id,path,specifier,body)=>{
 const dir=fixture(),source=`import {FPS} from '${specifier}';\n${body}`;
 put(dir,'src/テロップテンプレート/telopData.ts','export const telopData=[];');put(dir,'transcript.json',JSON.stringify({durationMs:10000,words:[],segments:[]}));put(dir,'src/'+path,source);
 expect(()=>loadProjectFromDir(dir)).toThrow();
 expect(()=>installNativeDataPack(id,dir)).toThrow();expect(readFileSync(join(dir,'src',path),'utf8')).toBe(source);expect(isNativeDataPackInstalled(id,dir)).toBe(false);
});
it.each(['speed','mainLayout'] as const)('keeps elided root videoConfig imports in supported literal %s data',id=>{
 const dir=fixture(),path=id==='speed'?'src/speedData.ts':'src/mainLayoutData.ts';
 const source="import {FPS} from './videoConfig';\n"+(id==='speed'?'export const MAIN_SPEED=2;':'export const MAIN_LAYOUT={scale:2};');
 put(dir,path,source);installNativeDataPack(id,dir);expect(readFileSync(join(dir,path),'utf8').startsWith(source)).toBe(true);expect(readNativeDataPackState(id,dir).status).toBe('ready');
});
it.each(['speed','mainLayout'] as const)('matches project loading for an explicit fallback on an unresolved root FPS import in %s',id=>{
 const dir=fixture(),path=id==='speed'?'src/speedData.ts':'src/mainLayoutData.ts';
 const source="import {FPS} from './videoConfig';\n"+(id==='speed'?'export const MAIN_SPEED=FPS ?? 2;':'export const MAIN_LAYOUT={scale:FPS ?? 2};');
 put(dir,'src/テロップテンプレート/telopData.ts','export const telopData=[];');put(dir,'transcript.json',JSON.stringify({durationMs:10000,words:[],segments:[]}));put(dir,path,source);
 const before=loadProjectFromDir(dir).project;installNativeDataPack(id,dir);const after=loadProjectFromDir(dir).project;
 expect(id==='speed'?before.mainSpeed:before.mainLayout?.scale).toBe(2);expect(id==='speed'?after.mainSpeed:after.mainLayout?.scale).toBe(2);
 expect(readFileSync(join(dir,path),'utf8').startsWith(source)).toBe(true);expect(readNativeDataPackState(id,dir).status).toBe('ready');
});
it('does not resolve an arbitrary videoConfig basename to the project FPS',()=>{
 const dir=fixture(),source="import {FPS} from './other/videoConfig';export const MAIN_SPEED=FPS/30;";
 put(dir,'src/speedData.ts',source);expect(()=>installNativeDataPack('speed',dir)).toThrow();expect(readFileSync(join(dir,'src/speedData.ts'),'utf8')).toBe(source);
});
it('repairs declarations for imports whose named specifiers are all inline type-only',()=>{
 const dir=fixture(),source="import {type BgmClip} from './types';export const bgmData:BgmClip[]=[];";
 put(dir,'src/Bgm/bgmData.ts',source);installNativeDataPack('bgm',dir);
 expect(existsSync(join(dir,'src/Bgm/types.d.ts'))).toBe(true);expect(readFileSync(join(dir,'src/Bgm/bgmData.ts'),'utf8')).toBe(source);
 const program=ts.createProgram([join(dir,'src/Bgm/bgmData.ts')],{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,moduleResolution:ts.ModuleResolutionKind.Bundler,module:ts.ModuleKind.ESNext});
 expect(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,' '))).toEqual([]);
 rmSync(join(dir,'src/Bgm/types.d.ts'));expect(readNativeDataPackState('bgm',dir).status).toBe('invalid');
 installNativeDataPack('bgm',dir);expect(readNativeDataPackState('bgm',dir).status).toBe('ready');
});
it('does not synthesize type declarations for a mixed value/type import',()=>{
 const dir=fixture(),source="import {type BgmClip, defaultFile} from './types';export const bgmData:BgmClip[]=[{id:1,startFrame:0,endFrame:30,file:defaultFile}];";
 put(dir,'src/Bgm/bgmData.ts',source);expect(()=>installNativeDataPack('bgm',dir)).toThrow();expect(existsSync(join(dir,'src/Bgm/types.d.ts'))).toBe(false);
});

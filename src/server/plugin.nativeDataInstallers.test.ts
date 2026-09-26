import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createServer,type ViteDevServer} from 'vite';import {smeServer} from './plugin';
import {readNativeDataPackState,type NativeDataPackId} from './nativeDataPacks';
import type {EditorProject} from '../core/types';
let root:string,server:ViteDevServer,base:string;
const protectedFiles=['src/MainVideo.tsx','src/Root.tsx','src/MainVideo.original.bak.tsx','package.json'];
beforeAll(async()=>{
 root=await mkdtemp(join(tmpdir(),'native-installer-http-'));await mkdir(join(root,'project/src/テロップテンプレート'),{recursive:true});
 await writeFile(join(root,'project/src/videoConfig.ts'),"export const VIDEO_FILE='main.mp4';export const FPS=30;export const DURATION_FRAMES=300;export const FORMAT='youtube';export const RESOLUTION={width:640,height:360};");
 await writeFile(join(root,'project/src/テロップテンプレート/telopData.ts'),'export const telopData=[];');await writeFile(join(root,'project/transcript.json'),JSON.stringify({durationMs:10000,words:[],segments:[]}));
 for(const file of protectedFiles)await writeFile(join(root,'project',file),'custom source '+file);
 vi.stubEnv('HARNESS_PROJECT_ROOT',root);vi.stubEnv('HARNESS_LEARNING_HOME',join(root,'learning'));server=await createServer({configFile:false,plugins:[smeServer()],logLevel:'silent',server:{host:'127.0.0.1',port:0,open:false}});await server.listen();const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('HTTP address missing');base=`http://127.0.0.1:${address.port}`;
});
afterAll(async()=>{await server?.close();vi.unstubAllEnvs();if(root)await rm(root,{recursive:true,force:true});});
it('installs and upgrades six data packs over actual HTTP without changing runtime sources',async()=>{
 for(const endpoint of ['bgm','video-insert','speed','transition','main-layout','shape']){
  const response=await fetch(`${base}/api/install-${endpoint}?id=project`,{method:'POST'}),body=await response.json();expect(response.status,JSON.stringify(body)).toBe(200);expect(body.installed).toBe(true);if(endpoint==='transition')expect(body.needsInstall).toBe(false);
 }
 const status=await fetch(`${base}/api/pack-status?id=project`);expect(status.status).toBe(200);expect(await status.json()).toEqual({stale:[],notices:[],revertable:false});
 const upgraded=await fetch(`${base}/api/pack-upgrade?id=project`,{method:'POST'});expect(upgraded.status).toBe(200);expect(await upgraded.json()).toEqual({upgraded:[],backups:{}});
 for(const file of protectedFiles)expect(await readFile(join(root,'project',file),'utf8')).toBe('custom source '+file);
});
it('returns a contextual failure for malformed data and does not silently reset it',async()=>{
 const path=join(root,'project/src/Bgm/bgmData.ts'),source='export const bgmData="invalid";';await writeFile(path,source);
 const response=await fetch(`${base}/api/install-bgm?id=project`,{method:'POST'}),body=await response.json();expect(response.status).toBe(400);expect(body.error).toContain('編集データを準備できません');expect(await readFile(path,'utf8')).toBe(source);
 const status=await fetch(`${base}/api/pack-status?id=project`);expect((await status.json()).stale).toContain('bgm');
});
it('keeps all six packs ready after default HTTP save and edited settings save',async()=>{
 const id='save-case',dir=join(root,id);await mkdir(join(dir,'src/テロップテンプレート'),{recursive:true});
 await writeFile(join(dir,'src/videoConfig.ts'),await readFile(join(root,'project/src/videoConfig.ts')));
 await writeFile(join(dir,'src/テロップテンプレート/telopData.ts'),'export const telopData=[];');
 await writeFile(join(dir,'transcript.json'),JSON.stringify({durationMs:10000,words:[],segments:[]}));
 const packs:NativeDataPackId[]=['bgm','videoInsert','speed','transition','mainLayout','shape'];
 for(const endpoint of ['bgm','video-insert','speed','transition','main-layout','shape']){
  const response=await fetch(`${base}/api/install-${endpoint}?id=${id}`,{method:'POST'});expect(response.status,await response.text()).toBe(200);
 }
 const assertReady=async()=>{
  const response=await fetch(`${base}/api/pack-status?id=${id}`);expect(response.status).toBe(200);expect(await response.json()).toEqual({stale:[],notices:[],revertable:false});
  expect(Object.fromEntries(packs.map(pack=>[pack,readNativeDataPackState(pack,dir).status]))).toEqual(Object.fromEntries(packs.map(pack=>[pack,'ready'])));
 };
 const load=async()=>{const response=await fetch(`${base}/api/project?id=${id}`);expect(response.status).toBe(200);return response.json();};
 const save=async(project:EditorProject,fingerprint:unknown)=>{const response=await fetch(`${base}/api/project?id=${id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({project,fingerprint})});expect(response.status,await response.text()).toBe(200);};
 await assertReady();let loaded=await load();const original=structuredClone(loaded.project);
 await save(loaded.project,loaded.save.fingerprint);await assertReady();loaded=await load();
 for(const key of ['bgm','videoInserts','shapes','sceneTransitions','mainSpeed','segmentSpeeds','mainLayout','layoutKeyframes','colorGrade'] as const)expect(loaded.project[key]).toEqual(original[key]);
 const populated:EditorProject={...loaded.project,
  bgm:[{id:1,originalStart:0,originalEnd:30,file:'music.wav',volume:0.4,fadeInFrames:0,fadeOutFrames:0}],
  videoInserts:[{id:2,originalStart:0,originalEnd:30,file:'insert.mp4',sourceInFrame:0,scale:0.5}],
  shapes:[{id:3,originalStart:0,originalEnd:30,kind:'rect',x1:0.1,y1:0.2,x2:0.8,y2:0.9,color:'#112233',thickness:'thin'}]};
 await save(populated,loaded.save.fingerprint);await assertReady();loaded=await load();
 expect(loaded.project.bgm).toMatchObject([{id:1,file:'music.wav',volume:0.4}]);expect(loaded.project.videoInserts).toMatchObject([{id:2,file:'insert.mp4',sourceInFrame:0,scale:0.5}]);expect(loaded.project.shapes).toMatchObject([{id:3,kind:'rect',color:'#112233'}]);
 const beforeSettings=structuredClone(loaded.project);
 const edited:EditorProject={...loaded.project,mainSpeed:1.5,mainLayout:{...loaded.project.mainLayout,scale:1.25},colorGrade:{...loaded.project.colorGrade,brightness:8}};
 await save(edited,loaded.save.fingerprint);await assertReady();loaded=await load();
 expect(loaded.project.mainSpeed).toBe(1.5);expect(loaded.project.mainLayout.scale).toBe(1.25);expect(loaded.project.colorGrade.brightness).toBe(8);
 for(const key of ['bgm','videoInserts','shapes','sceneTransitions'] as const)expect(loaded.project[key]).toEqual(beforeSettings[key]);
});

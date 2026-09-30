import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createTempProject,removeTempProject} from './helpers';
import {shotDir} from './shotDir';
import {resolveFfmpegBin} from '../src/server/resolveFfmpeg';
import {importSequenceAsset} from '../src/server/sequence/assets';
import {SequenceStore} from '../src/server/sequence/store';
import type {SequenceDocument} from '../src/core/sequence/model';
import {DEFAULT_MAIN_LAYOUT} from '../src/core/mainLayout';

test('a project missing its transcript can return home without trying to save',async({page})=>{
 const project=createTempProject('e2e-unavailable-home'),errors:string[]=[],saves:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/sequence/save')saves.push(request.url());});
 try{
  renameSync(join(project.dir,'transcript.json'),join(project.dir,'transcript.unavailable'));
  await page.goto(`/?project=${project.id}`);
  await page.getByRole('button',{name:'編集を始める',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('文字起こし transcript.json');
  await page.evaluate(()=>{(window as unknown as {homeMarker:string}).homeMarker='same-page';});
  await page.getByRole('button',{name:'ホームに戻る'}).click();
  await expect(page.locator('.native-home-app')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(()=>(window as unknown as {homeMarker:string}).homeMarker)).toBe('same-page');
  expect(saves).toEqual([]);expect(errors).toEqual([]);
 }finally{
  await page.goto('about:blank');removeTempProject(project.dir);
 }
});

test('external disk edits and AI commands refresh the live preview; project round trips keep the page and position',async({page,request},testInfo)=>{
 test.setTimeout(120000);
 const projects=[createTempProject('e2e-live-a'),createTempProject('e2e-live-b')],errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:900});
 try{
  const ff=resolveFfmpegBin();if(!ff.ok)throw new Error(ff.message);
  for(const [index,project] of projects.entries()){
   const file=join(project.dir,'live.mp4');execFileSync(ff.bin,['-v','error','-f','lavfi','-i',`color=${index?'blue':'red'}:s=320x180:r=30:d=2`,'-c:v','libx264','-pix_fmt','yuv420p',file]);
   const asset=await importSequenceAsset(project.dir,file,'live.mp4');
   const doc:SequenceDocument={schemaVersion:2,id:project.id,name:project.id,revision:0,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:60,background:'#000000',assets:[asset],tracks:[{id:'v',name:'映像',kind:'visual',enabled:true}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},clips:[{id:'clip',name:index?'B映像':'A映像',trackId:'v',startFrame:0,durationFrames:60,clock:{offset:{num:0,den:1},rate:{num:1,den:1},duration:{num:60,den:1}},content:{kind:'video',assetId:asset.id,streamIndex:0,sourceIn:{num:0,den:1},rate:{num:1,den:1}},visual:{layout:{...DEFAULT_MAIN_LAYOUT},opacity:1,keyframes:[]}}]};
   new SequenceStore(project.dir).save({document:doc,executionId:'initial',expectedSavedRevision:null});
  }
  const [a,b]=projects as [typeof projects[number],typeof projects[number]];
  await page.goto(`/?project=${a.id}`);await expect(page.getByRole('button',{name:'再生',exact:true})).toBeEnabled({timeout:30000});
  await page.evaluate(()=>{(window as unknown as {liveMarker:string}).liveMarker='same-page';});
  const frame=page.frameLocator('iframe[data-native-preview]');
  await expect(frame.locator('[data-native-clip="clip"] canvas')).toBeVisible();
  const pixel=()=>frame.locator('[data-native-clip="clip"] canvas').evaluate(el=>Array.from((el as HTMLCanvasElement).getContext('2d')!.getImageData(160,90,1,1).data));
  await expect.poll(async()=>(await pixel())[3]).toBe(255);
  const iframe=await page.locator('iframe[data-native-preview]').elementHandle();
  await page.getByTitle('1フレーム進む（→）').click();await expect(page.getByLabel('シークバー')).toHaveValue('1');
  // A real atomic file replacement at the SAME revision must update both views.
  const store=new SequenceStore(a.dir),external=store.load()!.document;
  external.clips[0]!.name='外部で変更';external.clips[0]!.visual!.opacity=.4;
  const envelope=JSON.parse(readFileSync(store.file,'utf8'));envelope.document=external;
  const start=Date.now();writeFileSync(store.file+'.external',JSON.stringify(envelope));renameSync(store.file+'.external',store.file);
  await expect(page.locator('[data-native-clip-id="clip"]')).toContainText('外部で変更');
  await expect.poll(async()=>(await pixel())[3]).toBe(102);
  const diskLatency=Date.now()-start;
  expect(await iframe!.evaluate(el=>el.isConnected)).toBe(true);
  await expect(page.getByLabel('シークバー')).toHaveValue('1');
  const session=await (await request.post(`/api/sequence/session?id=${a.id}`,{data:{}})).json();
  const aiStart=Date.now();const result=await request.post(`/api/sequence/command?id=${a.id}`,{data:{sessionId:session.sessionId,expectedRevision:session.document.revision,executionId:'external-ai',command:{type:'update-clip',clipId:'clip',patch:{name:'AIで変更'}}}});
  expect(result.ok()).toBe(true);await expect(page.locator('[data-native-clip-id="clip"]')).toContainText('AIで変更');const aiLatency=Date.now()-aiStart;
  const switchStart=Date.now();await page.getByRole('region',{name:'プロジェクト一覧'}).getByText(b.id,{exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`project=${b.id}`));await expect(page.getByRole('button',{name:'再生',exact:true})).toBeEnabled();
  await expect(page.locator('[data-native-clip-id="clip"]')).toContainText('B映像');
  await expect.poll(async()=>(await pixel())[2]).toBeGreaterThan(250);
  const switchLatency=Date.now()-switchStart;
  await page.getByRole('region',{name:'プロジェクト一覧'}).getByText(a.id,{exact:true}).click();
  await expect(page.locator('[data-native-clip-id="clip"]')).toContainText('AIで変更');
  await expect(page.getByLabel('シークバー')).toHaveValue('1');
  await expect.poll(async()=>(await pixel())[3]).toBe(102);
  expect(await page.evaluate(()=>(window as unknown as {liveMarker:string}).liveMarker)).toBe('same-page');
  expect(new SequenceStore(a.dir).load()!.document.clips[0]!.name).toBe('AIで変更');
  await page.goBack();await expect(page.locator('[data-native-clip-id="clip"]')).toContainText('B映像');
  await expect(page.getByRole('button',{name:'再生',exact:true})).toBeEnabled();
  await expect.poll(async()=>(await pixel())[2]).toBeGreaterThan(250);
  expect(await page.evaluate(()=>(window as unknown as {liveMarker:string}).liveMarker)).toBe('same-page');
  expect(errors).toEqual([]);
  await testInfo.attach('latency',{body:JSON.stringify({diskLatency,aiLatency,switchLatency}),contentType:'application/json'});
  await page.screenshot({path:join(shotDir('native-live-preview'),'live-project-switch.png')});
 }finally{await page.close();for(const project of projects)removeTempProject(project.dir);}
});

import {_electron as electron} from 'playwright-core';
import {expect} from '@playwright/test';
import {mkdtemp,readFile,writeFile,rename,symlink,lstat,readlink,realpath,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';

// Exercise the packaged preload with real OS file paths, outside the project root.
const build=JSON.parse(await readFile(new URL('../dist/desktop/latest.json',import.meta.url),'utf8'));
const root=await mkdtemp(join(tmpdir(),'harness-drop-smoke-')),projectRoot=join(root,'projects');
const ffmpeg=join(build.appPath,'Contents/Resources/runtime/tools/ffmpeg');
const first=join(root,'外付けの映像.mp4'),second=join(root,'追加の映像.mp4'),alias=join(root,'映像へのリンク.mp4'),base=join(root,'base.mp4');
for(const [path,color] of [[first,'red'],[second,'blue'],[base,'green']]){
 const generated=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i',`color=${color}:size=320x180:rate=30`,'-t','1','-c:v','libx264','-pix_fmt','yuv420p',path]);
 assert.equal(generated.status,0,generated.stderr.toString());
}
await symlink(first,alias);
let app;
try{
 console.log('LAUNCH',root);
 app=await electron.launch({executablePath:join(build.appPath,'Contents/MacOS/Harness Editor'),env:{...process.env,SME_BROWSE_ROOTS:root,HARNESS_DESKTOP_TEST:'1',HARNESS_DESKTOP_USER_DATA:join(root,'settings'),HARNESS_DESKTOP_PROJECT_ROOT:projectRoot},timeout:90000});
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await expect(page.locator('body')).toContainText('プロジェクト',{timeout:60000});
 console.log('OPEN',page.url());
 const origin=new URL(page.url()).origin;
 const create=await page.request.post(`${origin}/api/create-project?native=1&name=DropSmoke&video=base.mp4`,{data:await readFile(base),headers:{'content-type':'application/octet-stream'}});assert.ok(create.ok(),await create.text());
 await page.goto(`${origin}/?project=DropSmoke`);
 const zone=page.getByLabel('プロジェクトと素材');await expect(zone).toBeVisible({timeout:60000});
 assert.equal(await page.evaluate(()=>typeof window.harnessDesktop?.getPathForFile),'function');
 const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
 assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);
 const requests=[];page.on('request',r=>{if(r.url().includes('/api/sequence/'))requests.push(r.url());});
 const cdp=await page.context().newCDPSession(page),box=await zone.boundingBox();assert.ok(box);
 const drag={x:box.x+box.width/2,y:box.y+box.height/2,data:{items:[],files:[alias,second],dragOperationsMask:1}};
 await cdp.send('Input.dispatchDragEvent',{type:'dragEnter',...drag});await cdp.send('Input.dispatchDragEvent',{type:'dragOver',...drag});
 await expect(zone).toContainText('2件の素材を追加');
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','dark'));
 await page.screenshot({path:join(root,'drop-dark.png'),animations:'disabled'});
 await page.evaluate(()=>document.documentElement.setAttribute('data-theme','light'));
 await page.screenshot({path:join(root,'drop-light.png'),animations:'disabled'});
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await zone.locator('.native-file-drop').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await cdp.send('Input.dispatchDragEvent',{type:'drop',...drag});
 const current=async()=>await (await page.request.post(`${origin}/api/sequence/session?id=DropSmoke`,{data:{}})).json();
 await expect.poll(async()=>(await current()).document.assets.filter(a=>a.file.startsWith('.harness/references/')).length,{timeout:60000}).toBe(2);
 assert.ok(!requests.some(url=>url.includes('/sequence/upload')||url.includes('/reference-match')),'desktop drop must not copy or search');
 await expect(page.getByText('元の素材の保存場所を選ぶ',{exact:true})).toHaveCount(0);
 let session=await current();const linked=session.document.assets.filter(a=>a.file.startsWith('.harness/references/'));
 const project=join(projectRoot,'DropSmoke');
 for(const asset of linked)assert.equal((await lstat(join(project,asset.file))).isSymbolicLink(),true);
 const asset=linked.find(a=>a.name==='外付けの映像.mp4');assert.ok(asset);
 assert.equal(await readlink(join(project,asset.file)),await realpath(first));
 const before=JSON.stringify(session.document),relocated=join(root,'再接続した映像.mp4');await rename(first,relocated);
 await expect(page.getByRole('alert').filter({hasText:'素材が見つかりません'})).toBeVisible({timeout:15000});
 await expect(page.getByRole('button',{name:`${asset.name}をリンクし直す`})).toBeVisible();
 await page.screenshot({path:join(root,'disconnected.png')});
 await page.getByRole('button',{name:`${asset.name}をリンクし直す`}).click();
 await expect(page.getByText('元の素材に接続し直す',{exact:true})).toBeVisible();
 await page.locator('.mp-root').click();
 await page.locator('.mp-file').filter({hasText:'再接続した映像.mp4'}).click();
 await expect(page.getByRole('alert').filter({hasText:'素材が見つかりません'})).toHaveCount(0,{timeout:15000});
 session=await current();assert.equal(JSON.stringify(session.document),before,'relinking preserves the edit');
 assert.equal((await lstat(join(project,asset.file))).isSymbolicLink(),true);assert.equal(await readlink(join(project,asset.file)),await realpath(relocated));
 // Same mount path returns: warning clears without a manual relink.
 await rename(relocated,first);await expect(page.getByRole('alert').filter({hasText:'素材が見つかりません'})).toBeVisible({timeout:15000});
 await rename(first,relocated);await expect(page.getByRole('alert').filter({hasText:'素材が見つかりません'})).toHaveCount(0,{timeout:15000});
 await writeFile(join(root,'result.json'),JSON.stringify({passed:true,linked:linked.map(a=>({name:a.name,file:a.file})),errors,projectFiles:await readdir(project)},null,2));
 assert.deepEqual(errors,[]);console.log('PASS',root);
}finally{
 if(app){await app.evaluate(({app,dialog})=>{dialog.showMessageBoxSync=()=>1;app.quit();}).catch(()=>{});await app.close().catch(()=>{});}
}

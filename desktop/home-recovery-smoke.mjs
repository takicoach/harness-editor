import {_electron as electron} from 'playwright-core';
import {expect} from '@playwright/test';
import {mkdtemp,cp,rename,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';

const appPath=resolve(process.argv[2]);
const root=await mkdtemp(join(tmpdir(),'harness-home-recovery-'));
const projects=join(root,'projects'),unavailable=join(projects,'MissingTranscript');
await mkdir(projects,{recursive:true});
await cp(new URL('../src/server/__fixtures__/sample-project',import.meta.url),unavailable,{recursive:true});
await rename(join(unavailable,'transcript.json'),join(unavailable,'transcript.unavailable'));
const video=join(root,'sample.mp4');
execFileSync(join(appPath,'Contents/Resources/runtime/tools/ffmpeg'),['-v','error','-f','lavfi','-i','color=blue:s=320x180:r=30:d=1','-c:v','libx264','-pix_fmt','yuv420p',video]);
let app;
try{
 app=await electron.launch({executablePath:join(appPath,'Contents/MacOS/Harness Editor'),env:{...process.env,
  HARNESS_DESKTOP_TEST:'1',HARNESS_DESKTOP_USER_DATA:join(root,'settings'),HARNESS_DESKTOP_PROJECT_ROOT:projects,SME_TUTORIAL:'0',SME_AUTOSAVE:'0'},timeout:90000});
 const page=await app.firstWindow({timeout:90000}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await expect(page.locator('.native-home-app')).toBeVisible({timeout:60000});
 const origin=new URL(page.url()).origin;
 await page.goto(`${origin}/?project=MissingTranscript`);
 await expect(page.getByRole('button',{name:'編集を始める',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'ホームに戻る'}).click();
 await expect(page.locator('.native-home-app')).toBeVisible();
 await page.goto(`${origin}/?project=MissingTranscript`);
 await page.getByRole('button',{name:'編集を始める',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('文字起こし transcript.json');
 await page.getByRole('button',{name:'ホームに戻る'}).click();
 await expect(page.locator('.native-home-app')).toBeVisible();
 await page.screenshot({path:join(root,'recovered-home.png')});

 const created=await page.request.post(`${origin}/api/create-project?native=1&name=LoadedProject&video=sample.mp4`,{data:await readFile(video)});
 assert.ok(created.ok(),await created.text());
 const {id}=await created.json();
 await page.goto(`${origin}/?project=${encodeURIComponent(id)}`);
 await expect(page.getByRole('button',{name:'再生',exact:true})).toBeEnabled({timeout:45000});
 await page.route('**/api/sequence/save?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'検証用の保存失敗'})}));
 await page.getByRole('button',{name:'ホームに戻る'}).click();
 await expect(page.getByRole('alert')).toContainText('検証用の保存失敗');
 await expect(page.locator('.native-workspace')).toBeVisible();
 assert.equal(new URL(page.url()).searchParams.get('project'),id);
 await page.unroute('**/api/sequence/save?**');
 await page.getByRole('button',{name:'ホームに戻る'}).click();
 await expect(page.locator('.native-home-app')).toBeVisible();
 assert.deepEqual(errors,[]);
 const result={appPath,root,unmigratedHome:true,missingTranscriptHome:true,saveFailureProtected:true,saveRetryHome:true,errors};
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
 console.log('PASS',JSON.stringify(result));
}finally{
 if(app){
  const closed=app.waitForEvent('close',{timeout:10000});
  await app.evaluate(({dialog,app})=>{dialog.showMessageBoxSync=()=>1;app.quit();});
  await closed;
 }
}

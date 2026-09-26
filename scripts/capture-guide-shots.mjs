/** Capture the public 0.7 guide from the real editor, using a disposable project.
 * Usage: node scripts/capture-guide-shots.mjs --video /path/to/approved-demo.mp4
 * The source video must be cleared for publication. It is never copied into Git.
 */
import {chromium, expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2), video=args[args.indexOf('--video')+1];
const skipExport=args.includes('--skip-export'); // Keep the previous real export capture when adjusting other shots.
if(!args.includes('--video')||!video) throw new Error('Pass --video with footage approved for publication');
const work=mkdtempSync(join(tmpdir(),'harness-guide-07-'));
const output=join(repo,'docs/images/guide');
const name='ゴルフレッスンの振り返り', project=join(work,'projects',name);
const ffmpeg=process.env.HARNESS_FFMPEG??'ffmpeg';
cpSync(join(repo,'src/server/__fixtures__/sample-project'),project,{recursive:true});
for(const path of ['.sme','.harness','cut-baseline.json'])rmSync(join(project,path),{recursive:true,force:true});
execFileSync(ffmpeg,['-v','error','-y','-i',resolve(video),'-t','20','-vf','scale=540:960,fps=60','-c:v','libx264','-preset','fast','-crf','22','-c:a','aac',join(project,'public/main.mp4')]);
execFileSync(ffmpeg,['-v','error','-y','-ss','1','-i',join(project,'public/main.mp4'),'-frames:v','1',join(project,'public/images/sample.png')]);
const config=join(project,'src/videoConfig.ts');
writeFileSync(config,readFileSync(config,'utf8').replace('DURATION_FRAMES = 12000','DURATION_FRAMES = 1200'));
writeFileSync(join(project,'project-config.json'),JSON.stringify({format:'short',resolution:{width:1080,height:1920},fps:60,durationFrames:1200,sourceVideo:'main.mp4'}));
writeFileSync(join(project,'src/cutData.ts'),'export const cutData = [{id:1,originalStart:0,originalEnd:1200,playbackStart:0,playbackEnd:1200}];');
writeFileSync(join(project,'src/テロップテンプレート/telopData.ts'),`export const telopData = [
 {id:1,startFrame:330,endFrame:600,text:'フォームを見直してみましょう',template:1,animation:'none'},
 {id:2,startFrame:660,endFrame:900,text:'リズムを大切に',template:2,animation:'none'},
 {id:3,startFrame:960,endFrame:1140,text:'今日のレッスンを振り返る',template:3,animation:'none'}
];`);
process.env.HARNESS_PROJECT_ROOT=join(work,'projects');
process.env.HARNESS_LEARNING_HOME=join(work,'learning');
process.env.SUPERMOVIE_LEARNING_HOME=join(work,'learning');
process.env.HARNESS_PREFERENCE_TEST_FIXTURE='1';
process.env.SME_NO_OPEN='1';process.env.SME_TUTORIAL='0';
let browser,server;
console.log(`Capture workspace: ${work}`);
try {
 const {createServer}=await import('vite');
 server=await createServer({root:repo,cacheDir:join(work,'vite-cache'),server:{host:'127.0.0.1',port:0,open:false}});
 await server.listen();
 const base=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch();
 const context=await browser.newContext({viewport:{width:1600,height:1050},deviceScaleFactor:1});
 await context.route('**/api/ai/tools*',route=>route.fulfill({json:{tools:['claude','codex'].map(id=>({id,label:id==='claude'?'Claude':'Codex',installed:false,versionOk:false,installable:id==='claude',path:null,source:null,status:'missing'})),current:null,notes:[]}}));
 await context.route('**/api/pty/**',route=>route.abort());
 await context.addInitScript(()=>{if(!localStorage.getItem('sme-theme'))localStorage.setItem('sme-theme','dark');localStorage.setItem('sme-tutorial-done',new Date().toISOString());});
 const page=await context.newPage();page.setDefaultTimeout(30000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function shot(id,target=page) {
   await page.evaluate(()=>document.fonts.ready);
   await page.mouse.move(5,5);
   await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
   // Only replace the disposable folder label, preserving the actual product UI.
   await page.locator('.home-card-path').evaluateAll(nodes=>nodes.forEach(n=>{n.textContent='保存先: サンプル用フォルダ';n.setAttribute('title','サンプル用フォルダ');}));
   if((await page.locator('body').innerText()).includes(work))throw new Error('Temporary path visible');
   await target.screenshot({path:join(work,`${id}.png`),animations:'disabled'});
   console.log(`Captured ${id}`);
 }
 async function openProject(){
   await page.goto(base);
   await page.locator('.home-card',{hasText:name}).click();
   const migrate=page.getByRole('button',{name:'編集を始める',exact:true});
   await expect(migrate.or(page.locator('.native-timeline-panel'))).toBeVisible({timeout:60000});
   if(await migrate.isVisible())await migrate.click();
   await page.locator('.native-timeline-panel').waitFor({timeout:60000});
   await page.getByRole('group',{name:'モード',exact:true}).getByRole('button',{name:'編集',exact:true}).click();
   await expect(page.locator('.native-save-state')).not.toContainText('処理中',{timeout:60000});
   await page.getByRole('slider',{name:'シークバー'}).fill('180');
   await expect(page.locator('iframe[data-native-preview]')).toHaveAttribute('data-native-frame','180',{timeout:60000});
 }
 await page.goto(base);await page.locator('.home-card',{hasText:name}).waitFor();
 await shot('home');
 const photos=[];
 for(let i=1;i<=3;i++){const photo=join(work,`レッスン写真${i}.png`);cpSync(join(project,'public/images/sample.png'),photo);photos.push(photo);}
 const chooserPromise=page.waitForEvent('filechooser');
 await page.getByRole('button',{name:'動画を作成する',exact:false}).click();
 await (await chooserPromise).setFiles(photos);
 await expect(page.locator('.home-create-dialog')).toBeVisible();
 await page.getByRole('textbox',{name:'プロジェクト名'}).fill('レッスン写真のスライド');
 await shot('create-project',page.locator('.home-create-dialog'));
 await page.keyboard.press('Escape');
 await openProject();
 for(let i=0;i<5;i++)await page.getByRole('separator',{name:'タイムラインパネルのサイズ'}).press('ArrowUp');
 await shot('editor-dark');
 await page.evaluate(()=>localStorage.setItem('sme-theme','light'));await page.reload();
 await expect(page.locator('iframe[data-native-preview]')).toBeVisible({timeout:60000});
 await page.getByRole('slider',{name:'シークバー'}).fill('180');
 await expect(page.locator('iframe[data-native-preview]')).toHaveAttribute('data-native-frame','180',{timeout:60000});
 await shot('editor-light');
 await page.evaluate(()=>localStorage.setItem('sme-theme','dark'));await page.reload();
 await expect(page.locator('.native-timeline-panel')).toBeVisible({timeout:60000});
 await page.getByRole('slider',{name:'シークバー'}).fill('180');
 await expect(page.locator('iframe[data-native-preview]')).toHaveAttribute('data-native-frame','180',{timeout:60000});
 await shot('cut',page.locator('.native-timeline-panel'));
 await page.getByRole('tab',{name:'素材',exact:true}).click();await shot('materials');
 await page.getByRole('tab',{name:'字幕一覧',exact:true}).click();await shot('telop');
 await page.getByRole('button',{name:/^主映像 \d+〜/}).click();
 await page.getByRole('tab',{name:'調整',exact:true}).click();
 const look=page.locator('[data-group="look"] > h3 button');
 if(await look.getAttribute('aria-expanded')==='false')await look.click();
 for(let i=0;i<7;i++)await page.getByRole('separator',{name:'タイムラインパネルのサイズ'}).press('ArrowDown');
 for(let i=0;i<7;i++)await page.getByRole('separator',{name:'設定パネルのサイズ'}).press('ArrowLeft');
 await page.setViewportSize({width:1600,height:1320});
 await page.locator('.color-wheels').scrollIntoViewIfNeeded();
 await shot('color-grading');
 await page.setViewportSize({width:1600,height:1050});
 await page.locator('.native-ai-band').click();
 await page.getByRole('button',{name:'インストール',exact:true}).waitFor();
 await shot('ai');
 await page.locator('.native-ai-band').click();
 await page.getByRole('button',{name:'書き出し',exact:true}).click();
 await shot('export',page.getByRole('region',{name:'動画の書き出し'}));
 if(!skipExport){
 await page.getByLabel('書き出し解像度').selectOption('720p');
 await page.getByLabel('書き出し画質').selectOption('light');
 await page.getByRole('button',{name:'書き出し開始',exact:true}).click();
 await page.getByRole('dialog',{name:'AIとの差分レビュー'}).waitFor({timeout:10*60_000});
 await shot('learning');
 const review=await page.getByRole('dialog',{name:'AIとの差分レビュー'}).boundingBox();
 const exportPanel=await page.getByRole('region',{name:'動画の書き出し'}).boundingBox();
 const x=Math.max(0,Math.min(review.x,exportPanel.x)-20),y=Math.max(0,Math.min(review.y,exportPanel.y)-20);
 await page.screenshot({path:join(work,'learning-detail.png'),animations:'disabled',clip:{x,y,width:Math.min(1600,Math.max(review.x+review.width,exportPanel.x+exportPanel.width)+20)-x,height:Math.min(1050,Math.max(review.y+review.height,exportPanel.y+exportPanel.height)+20)-y}});
 }
 writeFileSync(join(work,'editor-dom.txt'),await page.locator('body').innerText());
 if(errors.length)throw new Error(errors.join('\n'));
 mkdirSync(output,{recursive:true});
 for(const id of ['home','create-project','editor-dark','editor-light','cut','materials','telop','color-grading','ai','export',...skipExport?[]:['learning','learning-detail']])cpSync(join(work,`${id}.png`),join(output,`${id}.png`));
 writeFileSync(join(output,'capture.json'),JSON.stringify({version:'0.7.0',capturedAt:new Date().toISOString(),viewport:{width:1600,height:1050},source:'approved sample video; disposable project; AI installation state shown as uninstalled'},null,2)+'\n');
 console.log(`Complete: ${output}`);
} catch(error) {
 const page=browser?.contexts()[0]?.pages()[0];
 if(page){await page.screenshot({path:join(work,'failure.png')});writeFileSync(join(work,'failure.txt'),await page.locator('body').innerText());}
 throw error;
} finally {await browser?.close();await server?.close();}

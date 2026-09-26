import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {resolveNativeChromiumBin} from '../../server/resolveNativeChromium';

const chrome=resolveNativeChromiumBin({editorRoot:process.cwd()});
if(!chrome.ok&&process.env.HARNESS_REQUIRE_CAPTURE_E2E==='1')throw new Error('タイムライン通知の必須検証にChromiumが必要です');
it.skipIf(!chrome.ok)('keeps a fade entry clickable after a rejected track drag while the notice is still visible',async()=>{
  const root=process.cwd();
  if(!chrome.ok)throw new Error(chrome.message);
  const bundle=await build({stdin:{contents:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {NativeTimeline} from './src/app/native/NativeTimeline';
    const r=num=>({num,den:1});
    const doc={schemaVersion:2,id:'fixture',name:'fixture',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:90,background:'#000',assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},
      tracks:[{id:'general',kind:'visual',name:'映像',enabled:true},{id:'fade',kind:'visual',name:'場面フェード',enabled:true}],
      clips:[{id:'general-clip',name:'一般映像',trackId:'general',startFrame:0,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'telop',data:{text:'text'}}},
        {id:'fade-clip',name:'色面',trackId:'fade',startFrame:0,durationFrames:90,clock:{offset:r(0),rate:r(1),duration:r(90)},content:{kind:'scene-fade',phase:'head',color:'#000000'}}]};
    window.observed={commands:[],targets:[],seeks:[]};
    createRoot(document.getElementById('root')).render(React.createElement(NativeTimeline,{document:doc,projectId:'isolated',waveform:'standard',frame:0,selected:[],range:null,tool:'select',zoom:1,snap:false,
      onSelect:()=>{},onRange:()=>{},onSeek:frame=>window.observed.seeks.push(frame),onDrop:()=>{},onCommand:async command=>{window.observed.commands.push(command);return true;},onSceneFade:target=>window.observed.targets.push(target)}));
  `,resolveDir:root,sourcefile:'timeline-notice-fixture.tsx',loader:'tsx'},bundle:true,write:false,outfile:'timeline-fixture.js',platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"test"'},logLevel:'silent'});
  const browser=await chromium.launch({executablePath:chrome.bin,headless:true});
  try{
    const page=await browser.newPage({viewport:{width:900,height:400}});
    page.setDefaultTimeout(4000);
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<style>body{margin:0}#root{display:flex;height:300px;--bg-1:white;--fg-1:black}</style><div id="root"></div>');
    await page.addStyleTag({content:await readFile(resolve(root,'src/app/native/native.css'),'utf8')});
    for(const file of bundle.outputFiles)if(file.path.endsWith('.css'))await page.addStyleTag({content:file.text});
    await page.addScriptTag({content:bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text});
    const clip=page.locator('[data-native-clip-id="general-clip"]');
    try{await clip.waitFor();}catch(error){throw new Error(`${String(error)}; page errors: ${errors.join('; ')}`);}
    const box=(await clip.boundingBox())!,target=(await page.locator('[data-native-track="fade"]').boundingBox())!;
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+box.width/2+5,target.y+target.height/2);await page.mouse.up();
    const notice=page.getByRole('status').locator('span');await notice.waitFor();expect(await notice.innerText()).toContain('場面フェード');
    const entry=page.getByRole('button',{name:'動画の最後のフェードを設定',exact:true});
    const entryBox=(await entry.boundingBox())!,noticeBox=(await notice.boundingBox())!;
    const x=entryBox.x+entryBox.width/2,y=entryBox.y+entryBox.height/2;
    // The test must exercise the actual overlap, not pass because its fixture moved the notice away.
    expect(x).toBeGreaterThan(noticeBox.x);expect(x).toBeLessThan(noticeBox.x+noticeBox.width);
    expect(y).toBeGreaterThan(noticeBox.y);expect(y).toBeLessThan(noticeBox.y+noticeBox.height);
    await entry.click({timeout:1500});
    expect(await notice.isVisible()).toBe(true);
    expect(await page.evaluate(()=> (window as unknown as {observed:unknown}).observed)).toEqual({commands:[],targets:[{kind:'tail'}],seeks:[]});
    expect(errors).toEqual([]);
  }finally{await browser.close();}
},20000);

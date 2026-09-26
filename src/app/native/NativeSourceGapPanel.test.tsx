/** @vitest-environment jsdom */
import {expect,it,vi,afterEach} from 'vitest';
import {render,fireEvent,cleanup,act} from '@testing-library/react';
import {NativeCutPanel} from './NativeCutPanel';
import {applySequenceCommand} from '../../core/sequence/commands';
import {rational as r} from '../../core/sequence/time';
import type {SequenceDocument} from '../../core/sequence/model';
function original():SequenceDocument{return {schemaVersion:2,id:'doc',name:'原本',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,background:'#000',
 tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true}],
 assets:[{id:'asset',kind:'media',name:'原本',file:'source.mp4',fingerprint:'a',streams:[{index:0,kind:'video',codec:'h264',duration:r(10),frameRate:r(30),width:320,height:180},{index:1,kind:'audio',codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],
 clips:[{id:'v1',name:'映像',trackId:'v',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},linkGroupId:'link',content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)}},
 {id:'a1',name:'原音',trackId:'a',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},linkGroupId:'link',content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:-8,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'}};}
function fixture(){const doc=applySequenceCommand(original(),{type:'ripple-delete',startFrame:90,endFrame:120});delete doc.cutArchive;return doc;}

it('requires a fresh owner choice when current adjacent settings become different',()=>{
 const doc=fixture();let state={sessionId:'one',document:doc,savedRevision:doc.revision,savedContentHash:'saved',dirty:false,canUndo:false,canRedo:false};
 const props={projectId:'doc',state,busy:false,frame:0,activeId:null,read:()=>state,prepare:async()=>true,execute:vi.fn(async()=>true),onWorking:()=>{},onRestored:()=>{}};
 const ui=render(<NativeCutPanel {...props}/>);
 expect(ui.getByRole('button',{name:'復元用の範囲に追加'})).toHaveProperty('disabled',false);
 const next=structuredClone(doc);next.revision++;const right=next.clips.find(c=>c.content.kind==='audio'&&c.startFrame===90)!;
 if(right.content.kind==='audio')right.content.settings.gainDb=-20;
 state={...state,document:next};ui.rerender(<NativeCutPanel {...props} state={state}/>);
 expect(ui.getByRole('button',{name:'復元用の範囲に追加'})).toHaveProperty('disabled',true);
 cleanup();
});

afterEach(cleanup);
it('rejects changed owner conditions during prepare rather than committing old automatic selection',async()=>{
 const doc=fixture();let state={sessionId:'one',document:doc,savedRevision:doc.revision,savedContentHash:'saved',dirty:false,canUndo:false,canRedo:false};
 let release!:(ok:boolean)=>void;const execute=vi.fn(async()=>true);
 const props={projectId:'doc',state,busy:false,frame:0,activeId:null,read:()=>state,prepare:()=>new Promise<boolean>(resolve=>{release=resolve;}),execute,onWorking:()=>{},onRestored:()=>{}};
 const ui=render(<NativeCutPanel {...props}/>);fireEvent.click(ui.getByRole('button',{name:'復元用の範囲に追加'}));
 const next=structuredClone(doc);next.revision++;const right=next.clips.find(c=>c.content.kind==='audio'&&c.startFrame===90)!;
 if(right.content.kind==='audio')right.content.settings.gainDb=-20;
 state={...state,document:next};ui.rerender(<NativeCutPanel {...props} state={state}/>);
 await act(async()=>release(true));expect(execute).not.toHaveBeenCalled();
});

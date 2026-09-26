/** @vitest-environment jsdom */
import {it,expect,beforeEach,afterEach,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createElement} from 'react';
import {cleanup,render,within} from '@testing-library/react';
import {NativeTimeline} from './NativeTimeline';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {applySequenceCommand} from '../../core/sequence/commands';

const timeline=readFileSync(join(__dirname,'NativeTimeline.tsx'),'utf8');
const icon=readFileSync(join(__dirname,'..','Icon.tsx'),'utf8');

it('タイムラインに ◆ と ↔ の文字グリフが無い（F11）',()=>{
  expect(timeline).not.toContain('◆');
  expect(timeline).not.toContain('↔');
});
it('Icon に link と fade-handle がある',()=>{
  expect(icon).toMatch(/\|\s*'link'/);
  expect(icon).toMatch(/\|\s*'fade-handle'/);
});

beforeEach(()=>{
  vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

function fixture():SequenceDocument{return {schemaVersion:2,id:'doc',name:'fixture',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:3000,background:'#000',
  assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'v',kind:'visual',name:'映像',enabled:true}],
  clips:[]};}
function videoClip(id:string,startFrame:number,durationFrames:number,extra:Partial<SequenceDocument['clips'][number]>={}){
  return {id,trackId:'v',name:id,startFrame,durationFrames,clock:{offset:r(0),rate:r(1),duration:r(durationFrames)},
    content:{kind:'video' as const,assetId:'a',streamIndex:0,sourceIn:r(0),rate:r(1)},...extra};
}
function mount(document:SequenceDocument,extra:Partial<Parameters<typeof NativeTimeline>[0]>={}){
  const props={projectId:'p',document,waveform:'standard' as const,frame:0,selected:[],range:null,tool:'select' as const,zoom:1,snap:false,ripple:false,
    onSelect:vi.fn(),onRange:vi.fn(),onSeek:vi.fn(),onDrop:vi.fn(),onCommand:vi.fn(async()=>true),onZoomChange:vi.fn(),...extra};
  const ui=render(createElement(NativeTimeline,props));
  const scroller=within(ui.container).getByLabelText('タイムライン');
  Object.defineProperties(scroller,{clientWidth:{configurable:true,value:1000},clientHeight:{configurable:true,value:300},scrollWidth:{configurable:true,value:4000}});
  (scroller as HTMLElement).getBoundingClientRect=()=>({left:0,right:1000,top:0,bottom:300,width:1000,height:300,x:0,y:0,toJSON(){}} as DOMRect);
  return ui;
}

it('幅 40px 未満のクリップだけに data-narrow が付く（境界含む）',()=>{
  const doc={...fixture(),clips:[videoClip('narrow',0,30),videoClip('wide',200,50),videoClip('boundary',400,40)]};
  const ui=mount(doc,{zoom:1});
  expect(ui.container.querySelector('[data-native-clip-id="narrow"]')?.hasAttribute('data-narrow')).toBe(true);
  expect(ui.container.querySelector('[data-native-clip-id="wide"]')?.hasAttribute('data-narrow')).toBe(false);
  expect(ui.container.querySelector('[data-native-clip-id="boundary"]')?.hasAttribute('data-narrow')).toBe(false);
});

it('finish モードの分割表示（piece）側にも data-narrow が付く',()=>{
  const base={...fixture(),clips:[{id:'overlay',trackId:'v',name:'overlay',startFrame:320,durationFrames:30,
    clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'telop' as const,data:{text:'overlay'}}}]};
  const doc=applySequenceCommand(base,{type:'ripple-delete',startFrame:330,endFrame:350});
  const ui=mount(doc,{mode:'finish',frame:335,zoom:2});
  const pieces=ui.container.querySelectorAll('[data-native-clip-id="overlay"] [data-native-display-start]');
  expect(pieces.length).toBeGreaterThan(0);
  pieces.forEach(piece=>expect(piece.hasAttribute('data-narrow')).toBe(true));
});

it('映像クリップ幅の中央値 < 40 で .native-timeline に data-dense が付く（境界は付かない）',()=>{
  const dense=mount({...fixture(),clips:[videoClip('a',0,30)]},{zoom:1});
  expect(dense.container.querySelector('.native-timeline')?.hasAttribute('data-dense')).toBe(true);
  const boundary=mount({...fixture(),clips:[videoClip('a',0,40)]},{zoom:1});
  expect(boundary.container.querySelector('.native-timeline')?.hasAttribute('data-dense')).toBe(false);
  const sparse=mount({...fixture(),clips:[videoClip('a',0,50)]},{zoom:1});
  expect(sparse.container.querySelector('.native-timeline')?.hasAttribute('data-dense')).toBe(false);
});

it('リンクの鎖 .native-clip-link は linkGroupId 付きクリップにだけ出る',()=>{
  const doc={...fixture(),clips:[videoClip('linked',0,200,{linkGroupId:'g'}),videoClip('plain',300,200)]};
  const ui=mount(doc,{zoom:1});
  expect(ui.container.querySelector('[data-native-clip-id="linked"] .native-clip-link')).not.toBeNull();
  expect(ui.container.querySelector('[data-native-clip-id="plain"] .native-clip-link')).toBeNull();
});

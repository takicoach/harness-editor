/** @vitest-environment jsdom */
import {createRef} from 'react';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,render} from '@testing-library/react';
import {NativePreviewManipulation,type NativeManipulationHandle,type PreviewPlacementCommit,type PreviewShapeCommit} from './NativePreviewManipulation';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {MAX_SEQUENCE_COMMAND_LEAVES} from '../../core/sequence/commandTypes';
import {DEFAULT_MAIN_LAYOUT} from '../../core/mainLayout';
import type {RenderedSceneGeometry} from '../../preview/native/renderGeometry';
const resizeCallbacks=new Set<()=>void>();
beforeEach(()=>vi.stubGlobal('ResizeObserver',class {
  constructor(readonly callback:()=>void){resizeCallbacks.add(callback);}
  observe(){}
  disconnect(){resizeCallbacks.delete(this.callback);}
}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();resizeCallbacks.clear();});
const deferred=()=>{let resolve!:(ok:boolean)=>void;const promise=new Promise<boolean>(done=>{resolve=done;});return {promise,resolve};};
const pointer=(target:EventTarget,type:string,x:number,y:number)=>{const event=new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);};
function fixture(prepare:()=>Promise<boolean>=async()=>true,commit:()=>Promise<boolean>=async()=>true,
  options:{image?:boolean;element?:'text'|'title'|'rect'|'ellipse'|'triangle'|'line'|'arrow'|'angle';selected?:string[];snapEnabled?:boolean;configure?:(document:SequenceDocument,geometry:RenderedSceneGeometry)=>void;draw?:(document:SequenceDocument|null)=>Promise<void>}={}){
  let document:SequenceDocument={schemaVersion:2,id:'doc',name:'test',revision:1,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:100,background:'#000000',assets:[],tracks:[{id:'v',name:'映像',kind:'visual',enabled:true}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},clips:[{id:'video',name:'映像',trackId:'v',startFrame:0,durationFrames:100,clock:{offset:r(0),rate:r(1),duration:r(100)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]}}]};
  const geometry:RenderedSceneGeometry={documentId:'doc',revision:1,frame:10,resolution:document.resolution,videos:[{clipId:'video',source:{displayWidth:320,displayHeight:180,sampleAspectRatio:1,rotation:0},fittedSize:{width:320,height:180},transform:{x:0,y:0,scale:1,rotation:0,flipH:false,flipV:false,opacity:1},bounds:{x:0,y:0,width:320,height:180,rotation:0},transition:false,animated:false}]};
  if(options.image){
    document.clips[0]!.content={kind:'image',assetId:'image',style:'plain'};
    geometry.images=[{...geometry.videos[0]!,source:{displayWidth:100,displayHeight:200,sampleAspectRatio:1,rotation:0},fittedSize:{width:90,height:180},bounds:{x:115,y:0,width:90,height:180,rotation:0}}];geometry.videos=[];
  }
  if(options.element){
    document.clips[0]!.content=options.element==='text'?{kind:'telop',textMode:'free',data:{text:'テキスト'}}
      :options.element==='title'?{kind:'title',data:{text:'タイトル'},style:{top:20,left:15,fontSize:24}}
      :{kind:'shape',data:{kind:options.element,x1:.1,y1:.2,x2:.4,y2:.5,color:'#ffffff',thickness:'medium',
        ...(options.element==='angle'?{x3:.6,y3:.2}:{})}};
    if(options.element==='title'){document.clips[0]!.visual!.enter={kind:'none',frames:0};document.clips[0]!.visual!.exit={kind:'none',frames:0};}
    geometry.elements=[{...geometry.videos[0]!,localBounds:{x:20,y:110,width:100,height:40},fittedSize:{width:100,height:40}}];geometry.videos=[];
  }
  options.configure?.(document,geometry);
  let width=320,height=180,left=0;
  const stage=window.document.createElement('div');stage.getBoundingClientRect=()=>({x:left,y:0,left,top:0,right:left+width,bottom:height,width,height,toJSON(){return {};}});
  const ref=createRef<NativeManipulationHandle>(),commands:PreviewPlacementCommit[]=[],shapeCommands:PreviewShapeCommit[]=[],frames:Array<SequenceDocument|null>=[],busy:boolean[]=[];
  const props={document,frame:10,geometry,stage:{current:stage},selected:options.selected??['video'],snapEnabled:options.snapEnabled,disabled:false,externalBusy:false,readDocument:()=>document,prepare,pause:vi.fn(),onBusy:(value:boolean)=>busy.push(value),
    render:async(value:SequenceDocument|null)=>{frames.push(value);await options.draw?.(value);return geometry;},commit:async(change:PreviewPlacementCommit)=>{commands.push(change);return commit();},
    commitShape:async(change:PreviewShapeCommit)=>{shapeCommands.push(change);return commit();}};
  const view=render(<NativePreviewManipulation ref={ref} {...props}/>),handle=view.queryByLabelText(`選択した${options.element==='text'?'テキスト':options.element==='title'?'タイトル':options.element?'図形':options.image?'画像':'映像'}を移動`)!;
  if(handle)Object.defineProperty(handle,'setPointerCapture',{value:()=>{}});
  const grab=(name:string)=>{const target=view.getByLabelText(name,{exact:true});Object.defineProperty(target,'setPointerCapture',{value:()=>{}});return target;};
  return {view,handle,grab,ref,commands,shapeCommands,frames,busy,resize(w:number,h:number){width=w;height=h;resizeCallbacks.forEach(callback=>callback());},setStageRect(l:number,w:number,h:number){left=l;width=w;height=h;resizeCallbacks.forEach(callback=>callback());},external(){document={...document,revision:2};view.rerender(<NativePreviewManipulation ref={ref} {...props} document={document}/>);}};
}
it.each(['Escape','flush','refusal'] as const)('waits for canonical pixels before ending %s restoration',async kind=>{
  const wait=deferred(),test=fixture(undefined,async()=>false,{draw:async document=>{if(!document)await wait.promise;}});
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>pointer(window,'pointermove',132,98));
  let flushed!:Promise<boolean>,done=false;
  await act(async()=>{
    if(kind==='Escape')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    if(kind==='refusal')pointer(window,'pointerup',132,98);
    if(kind==='flush')flushed=test.ref.current!.restore();
  });
  flushed??=test.ref.current!.restore();void flushed.then(()=>{done=true;});
  expect(test.busy.at(-1)).toBe(true);expect(test.view.container.querySelector('svg')!.dataset.nativeManipulation).toBe('restoring');
  expect(test.view.getByRole('status').textContent).not.toContain('戻しました');expect(done).toBe(false);
  const before=test.frames.length;
  await act(async()=>pointer(test.handle,'pointerdown',100,80));expect(test.frames).toHaveLength(before);
  await act(async()=>wait.resolve(true));expect(await flushed).toBe(true);
  expect(test.busy.at(-1)).toBe(false);expect(test.view.container.querySelector('svg')!.dataset.nativeManipulation).toBe('idle');
});

it('reports a restoration failure while keeping data flush usable and retries pixels explicitly',async()=>{
  let fail=true;
  const test=fixture(undefined,undefined,{draw:async document=>{if(!document&&fail)throw new Error('復元描画に失敗');}});
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>pointer(window,'pointermove',132,98));
  await act(async()=>expect(await test.ref.current!.restore()).toBe(false));
  expect(await test.ref.current!.flush()).toBe(true);
  expect(test.view.getByRole('status').textContent).toContain('復元描画に失敗');expect(test.busy.at(-1)).toBe(false);
  expect(test.commands).toHaveLength(0);fail=false;
  await act(async()=>expect(await test.ref.current!.restore()).toBe(true));
  expect(test.frames.at(-1)).toBeNull();expect(test.view.getByRole('status').textContent).not.toContain('失敗');
});

it('keeps cancelled preparation cancelled while its canonical restoration is delayed',async()=>{
  const prepare=deferred(),restore=deferred(),test=fixture(()=>prepare.promise,undefined,{draw:async document=>{if(!document)await restore.promise;}});
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>pointer(window,'pointerup',132,98));
  await act(async()=>prepare.resolve(true));
  expect(test.frames).toEqual([null]);expect(test.commands).toHaveLength(0);
  expect(test.view.container.querySelector('svg')!.dataset.nativeManipulation).toBe('restoring');
  const reached=vi.fn();window.addEventListener('keydown',reached);
  try{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));expect(reached).toHaveBeenCalledOnce();}
  finally{window.removeEventListener('keydown',reached);}
  await act(async()=>restore.resolve(true));expect(test.busy.at(-1)).toBe(false);
});

it('ignores a late provisional draw failure after restoration and a newer gesture',async()=>{
  let reject!: (error:Error)=>void;
  const old=new Promise<void>((_resolve,no)=>reject=no);
  let draws=0;
  const test=fixture(undefined,undefined,{draw:async document=>{if(document&&++draws===2)await old;}});
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>expect(await test.ref.current!.flush()).toBe(true));
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>reject(new Error('古い一時描画の失敗')));
  expect(test.view.queryByRole('status')).toBeNull();
  expect(test.view.container.querySelector('svg')!.dataset.nativeManipulation).toBe('dragging');
  await act(async()=>test.ref.current!.flush());
});

it('does not publish an old restoration completion after unmount',async()=>{
  const restore=deferred(),test=fixture(undefined,undefined,{draw:async document=>{if(!document)await restore.promise;}});
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  let flushed!:Promise<boolean>;
  await act(async()=>{flushed=test.ref.current!.restore();});
  test.view.unmount();const busy=test.busy.slice();
  await act(async()=>restore.resolve(true));expect(await flushed).toBe(false);expect(test.busy).toEqual(busy);
});

it('keeps a successful commit saveable when drawing fails and does not resend on pixel recovery',async()=>{
  let fail=true;
  const test=fixture(undefined,undefined,{draw:async document=>{if(!document&&fail)throw new Error('保存後の描画失敗');}});
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>pointer(window,'pointermove',132,98));
  let flushed!:Promise<boolean>;
  await act(async()=>{pointer(window,'pointerup',132,98);flushed=test.ref.current!.flush();});
  expect(await flushed).toBe(true);expect(test.commands).toHaveLength(1);
  await act(async()=>expect(await test.ref.current!.restore()).toBe(false));
  fail=false;await act(async()=>expect(await test.ref.current!.restore()).toBe(true));expect(test.commands).toHaveLength(1);
});

it('does not begin after pointerup while input flushing is still pending',async()=>{
  const wait=deferred(),test=fixture(()=>wait.promise);
  await act(async()=>pointer(test.handle,'pointerdown',100,80));await act(async()=>pointer(window,'pointerup',140,80));await act(async()=>wait.resolve(true));
  expect(test.commands).toHaveLength(0);expect(test.frames.every(value=>value===null)).toBe(true);expect(test.busy.at(-1)).toBe(false);
});

// Review reproduction: execute the unchanged Workspace save body so this probe
// observes its real early-return ordering, without mocking an invented consumer.
function workspaceSaveForReview(test:ReturnType<typeof fixture>){
  const source=readFileSync('src/app/native/NativeWorkspace.tsx','utf8');
  const body=source.match(/const save=useCallback\(((?:async)?\(\)=>\{[\s\S]*?\n  \}),\[nativeSession.save\]\);/)?.[1];
  if(!body)throw new Error('Workspace save source changed; review probe needs inspection');
  const inspector=vi.fn(async()=>true),script=vi.fn(async()=>true),save=vi.fn(async()=>true),resume=vi.fn(),uiSound=vi.fn();
  const timeline=vi.fn(async()=>true),captions=vi.fn(async()=>true),cuts=vi.fn(async()=>true);
  // The save body also guards concurrent saves (viewSave) and project changes (saveEpoch) and shows progress (setPreparingSave).
  const invoke=new Function('player','inspector','scriptPanel','nativeSession','agent','timeline','captionPanel','cutPanel','uiSound','viewSave','saveEpoch','setPreparingSave',`return ${ts.transpileModule(`(${body})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText}`)(
    {current:{flushManipulation:()=>test.ref.current!.flush()}},{current:{flush:inspector}},
    {current:{flush:script}},{save},{resumeAutoSave:resume},{current:{flush:timeline}},
    {current:{flush:captions}},{current:{flush:cuts}},uiSound,{current:null},{current:0},()=>undefined) as ()=>Promise<boolean>;
  return {invoke,inspector,script,save,resume,uiSound};
}

it('saves committed data through the real Workspace consumer despite persistent restoration failure',async()=>{
  const test=fixture(undefined,undefined,{draw:async document=>{if(!document)throw new Error('persistent drawing failure');}});
  const save=workspaceSaveForReview(test);
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>pointer(window,'pointermove',132,98));
  await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  let result!:boolean;await act(async()=>{result=await save.invoke();});
  console.info('F-A persistent failure',JSON.stringify({result,inspectorFlushes:save.inspector.mock.calls.length,scriptFlushes:save.script.mock.calls.length,saves:save.save.mock.calls.length,commands:test.commands.length,notice:test.view.getByRole('status').textContent}));
  expect(result).toBe(true);expect(save.save).toHaveBeenCalledOnce();
});

it('does not tie data saving to a renderer provider that never settles',async()=>{
  vi.useFakeTimers();const wait=deferred();
  const test=fixture(undefined,undefined,{draw:async document=>{if(!document)await wait.promise;}}),save=workspaceSaveForReview(test);
  let pending:Promise<boolean>|undefined,settled=false;
  try{
    await act(async()=>pointer(test.handle,'pointerdown',100,80));
    await act(async()=>pointer(window,'pointermove',132,98));
    await act(async()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));pending=save.invoke().then(value=>{settled=true;return value;});});
    await act(async()=>vi.advanceTimersByTimeAsync(60_000));
    console.info('F-A stalled for 60s',JSON.stringify({settled,inspectorFlushes:save.inspector.mock.calls.length,scriptFlushes:save.script.mock.calls.length,saves:save.save.mock.calls.length,busy:test.busy.at(-1),phase:test.view.container.querySelector('svg')!.dataset.nativeManipulation}));
    expect(settled).toBe(true);expect(save.save).toHaveBeenCalledOnce();
  }finally{await act(async()=>wait.resolve(true));await pending;vi.useRealTimers();}
});

it.each([0,31,135].flatMap(rotation=>[false,true].flatMap(flipH=>[
  {rotation,flipH,x:7,y:9},{rotation,flipH,x:160,y:90},{rotation,flipH,x:313,y:171},
])))('separates the small title move grip from its real corners: %j',async({rotation,flipH,x,y})=>{
  const test=fixture(undefined,undefined,{element:'title',configure:(doc,geometry)=>{
    const item=geometry.elements![0]!;
    item.localBounds={x:155,y:82,width:10,height:16};item.fittedSize={width:10,height:16};
    Object.assign(item.transform,{x:(x-160)/160,y:(y-90)/90,scale:.8,rotation,flipH});
    Object.assign(doc.clips[0]!.visual!.layout,{position:{x:(x-160)/160,y:(y-90)/90},scale:.8,rotation,flipH});
  }});
  await act(async()=>test.resize(208,117));
  const grip=test.view.getByLabelText('選択したタイトルを移動');
  expect(grip.hasAttribute('data-native-move-grip')).toBe(true);
  expect(test.view.getAllByLabelText('選択したタイトルを移動')).toHaveLength(1);
  const gx=Number(grip.getAttribute('x')),gy=Number(grip.getAttribute('y'));
  const gw=Number(grip.getAttribute('width')),gh=Number(grip.getAttribute('height'));
  // SVG stroke-width=2 paints 1px outside the rectangle's layout box.
  expect(gx-1).toBeGreaterThanOrEqual(0);expect(gy-1).toBeGreaterThanOrEqual(0);
  expect(gx+gw+1).toBeLessThanOrEqual(208);expect(gy+gh+1).toBeLessThanOrEqual(117);
  const angle=rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  const draw=(dx:number,dy:number)=>({x:.65*(x+.8*(c*dx*(flipH?-1:1)-s*dy)),y:.65*(y+.8*(s*dx*(flipH?-1:1)+c*dy))});
  for(const [label,dx,dy] of [['左上',-5,-8],['右上',5,-8],['右下',5,8],['左下',-5,8]] as const){
    const corner=test.view.getByLabelText(`タイトルの${label}を拡縮`),cx=Number(corner.getAttribute('x')),cy=Number(corner.getAttribute('y'));
    expect(Number(corner.getAttribute('width'))).toBe(12);expect(Number(corner.getAttribute('height'))).toBe(12);
    expect(cx+6).toBeCloseTo(draw(dx,dy).x,10);expect(cy+6).toBeCloseTo(draw(dx,dy).y,10);
    expect(gx+gw+1<cx-1||gx-1>cx+13||gy+gh+1<cy-1||gy-1>cy+13).toBe(true);
  }
  const at={x:gx+gw/2,y:gy+gh/2};
  await act(async()=>pointer(grip,'pointerdown',at.x,at.y));
  await act(async()=>pointer(window,'pointermove',at.x+20,at.y+10));
  expect(test.commands).toHaveLength(0);
  await act(async()=>pointer(window,'pointerup',at.x+20,at.y+10));
  expect(test.commands).toHaveLength(1);
  const layout=test.commands[0]!.changes[0]!.visual.layout;
  expect(layout.position.x).toBeCloseTo((x-160)/160+40/208,10);
  expect(layout.position.y).toBeCloseTo((y-90)/90+20/117,10);
  expect(layout.scale).toBe(.8);expect(layout.rotation).toBe(rotation);expect(layout.flipH).toBe(flipH);
});

it.each(['text','title','rect','ellipse'] as const)('moves %s provisionally and commits only outer placement',async element=>{
  const test=fixture(undefined,undefined,{element});
  expect(test.handle.getAttribute('points')).toBe('20,110 120,110 120,150 20,150');
  await act(async()=>pointer(test.handle,'pointerdown',50,125));
  await act(async()=>pointer(window,'pointermove',82,143));
  expect(test.commands).toHaveLength(0);expect(test.frames.at(-1)!.clips[0]!.content.kind).toBe(element==='text'?'telop':element==='title'?'title':'shape');
  expect(test.frames.at(-1)!.clips[0]!.visual!.layout.position).toEqual({x:.2,y:.2});
  await act(async()=>pointer(window,'pointerup',82,143));
  expect(test.commands).toHaveLength(1);expect(test.commands[0]!.changes[0]!.visual.layout.position).toEqual({x:.2,y:.2});
  if(element==='title')for(const visual of [test.frames.find(value=>value)!.clips[0]!.visual!,test.commands[0]!.changes[0]!.visual]){
    expect(visual.enter).toEqual({kind:'none',frames:0});expect(visual.exit).toEqual({kind:'none',frames:0});expect(visual.motion).toBeUndefined();
  }
});

it.each(['左上','右上','右下','左下'])('resizes the nearest real %s corner when tiny handle hit boxes overlap',async label=>{
  const test=fixture(undefined,undefined,{element:'title',configure:(doc,geometry)=>{
    geometry.elements![0]!.localBounds={x:155,y:82,width:10,height:16};
    Object.assign(geometry.elements![0]!.transform,{scale:.2,rotation:31});
    Object.assign(doc.clips[0]!.visual!.layout,{scale:.2,rotation:31});
  }});
  const location=(name:string)=>{const node=test.view.getByLabelText(`タイトルの${name}を拡縮`);return {x:Number(node.getAttribute('x'))+6,y:Number(node.getAttribute('y'))+6};};
  const opposite=({'左上':'右下','右上':'左下','右下':'左上','左下':'右上'} as const)[label as '左上'];
  const start=location(label),anchor=location(opposite),end={x:anchor.x+.75*(start.x-anchor.x),y:anchor.y+.75*(start.y-anchor.y)};
  // All four centers lie inside the last-painted sw rect at this scale.
  const hit=test.view.getByLabelText('タイトルの左下を拡縮');Object.defineProperty(hit,'setPointerCapture',{value:()=>{}});
  expect(Math.abs(start.x-location('左下').x)).toBeLessThan(6);expect(Math.abs(start.y-location('左下').y)).toBeLessThan(6);
  await act(async()=>pointer(hit,'pointerdown',start.x,start.y));await act(async()=>pointer(window,'pointerup',end.x,end.y));
  expect(test.commands).toHaveLength(1);const layout=test.commands[0]!.changes[0]!.visual.layout;
  expect(layout.scale).toBeCloseTo(.15,10);expect(layout.rotation).toBe(31);
  // Reconstruct from the original rendered anchor, independent of handle UI.
  expect(160+layout.position.x*160+(anchor.x-160)*.75).toBeCloseTo(anchor.x,10);
  expect(90+layout.position.y*90+(anchor.y-90)*.75).toBeCloseTo(anchor.y,10);
});

it.each(['text','title','rect','ellipse'] as const)('resizes an offset flipped %s around the opposite content corner',async element=>{
  const test=fixture(undefined,undefined,{element,configure:(doc,geometry)=>{
    doc.clips[0]!.visual!.layout.flipH=true;geometry.elements![0]!.transform.flipH=true;
  }}),label=element==='text'?'テキスト':element==='title'?'タイトル':'図形';
  // Local nw=(20,110), se=(120,150), CSS flip about (160,90):
  // nw=(300,110), se=(200,150). Half-size, opposite nw unchanged.
  const handle=test.view.getByLabelText(`${label}の右下を拡縮`);
  Object.defineProperty(handle,'setPointerCapture',{value:()=>{}});
  expect(Number(handle.getAttribute('x'))+6).toBe(200);
  await act(async()=>pointer(handle,'pointerdown',200,150));
  await act(async()=>pointer(window,'pointerup',250,130));
  const layout=test.commands[0]!.changes[0]!.visual.layout;
  expect(layout.scale).toBeCloseTo(.5,12);expect(layout.flipH).toBe(true);
  // Independent CSS reconstruction, starting from the unchanged local corners.
  const draw=(x:number,y:number)=>({x:160+layout.position.x*160-(x-160)*layout.scale,y:90+layout.position.y*90+(y-90)*layout.scale});
  expect(draw(20,110).x).toBeCloseTo(300,10);expect(draw(20,110).y).toBeCloseTo(110,10);
  expect(draw(120,150).x).toBeCloseTo(250,10);expect(draw(120,150).y).toBeCloseTo(130,10);
  if(element==='title')for(const visual of [test.frames.find(value=>value)!.clips[0]!.visual!,test.commands[0]!.changes[0]!.visual]){
    expect(visual.enter).toEqual({kind:'none',frames:0});expect(visual.exit).toEqual({kind:'none',frames:0});expect(visual.motion).toBeUndefined();
  }
});

it('keeps an inactive component binding while manipulating active free text at the current key',async()=>{
  const keys=[{frame:r(0),value:{position:{x:0,y:0}}},{frame:r(20),value:{position:{x:.2,y:0}}}];
  const test=fixture(undefined,undefined,{element:'text',configure:(doc,geometry)=>{
    const content=doc.clips[0]!.content;if(content.kind==='telop')content.componentAssetId='inactive';
    doc.rendering={telopComponentAssetId:'inactive-document',telopBottomOffset:null,telopFontSize:null};
    doc.clips[0]!.visual!.keyframes=structuredClone(keys);geometry.elements![0]!.transform.x=.1;
  }});
  await act(async()=>pointer(test.handle,'pointerdown',80,130));await act(async()=>pointer(window,'pointerup',112,130));
  const visual=test.commands[0]!.changes[0]!.visual;
  expect(visual.layout.position).toEqual({x:0,y:0});expect(visual.keyframes.filter(key=>key.frame.num!==10)).toEqual(keys);
  expect(visual.keyframes.find(key=>key.frame.num===10)!.value.position!.x).toBeCloseTo(.3,12);
  const content=test.frames.find(value=>value)?.clips[0]!.content;expect(content?.kind==='telop'&&content.componentAssetId).toBe('inactive');
});

it.each(['component','animation','motion','enter'] as const)('does not guess text geometry with inner %s',issue=>{
  const test=fixture(undefined,undefined,{element:'text',configure:doc=>{
    const clip=doc.clips[0]!,content=clip.content;if(content.kind!=='telop')throw new Error('fixture');
    if(issue==='component')content.textMode='component';
    else if(issue==='animation')content.data.animation='charByChar';
    else if(issue==='motion')content.data.motion={preset:'custom',from:{x:0},to:{x:1}};
    else clip.visual!.enter={kind:'slideIn',frames:10,direction:'left'};
  }});
  expect(test.handle).toBeNull();expect(test.view.container.textContent).toMatch(issue==='component'?/部品/:issue==='enter'?/登場/:/内側/);
});

it.each([undefined,.6,1e-7,20])('preserves native added text inner position and scale %s when moving its outer placement',async scale=>{
  const test=fixture(undefined,undefined,{element:'text',configure:doc=>{
    const content=doc.clips[0]!.content;if(content.kind!=='telop')throw new Error('fixture');
    content.data.position={x:0,y:-.5};content.data.scale=scale;
  }});
  expect(test.handle).not.toBeNull();
  await act(async()=>pointer(test.handle,'pointerdown',50,125));await act(async()=>pointer(window,'pointermove',82,143));
  const content=test.frames.at(-1)!.clips[0]!.content;if(content.kind!=='telop')throw new Error('fixture');
  expect(content.data.position).toEqual({x:0,y:-.5});expect(content.data.scale).toBe(scale);
  await act(async()=>pointer(window,'pointerup',82,143));
  expect(test.commands).toHaveLength(1);expect(test.commands[0]!.changes[0]!.visual.layout.position).toEqual({x:.2,y:.2});
});

it('offers the same four-corner box as rect for a triangle',()=>{
  const test=fixture(undefined,undefined,{element:'triangle'});
  expect(test.handle).not.toBeNull();
  expect(test.handle.getAttribute('aria-label')).toBe('選択した図形を移動');
  expect(test.view.container.querySelector('polygon')).not.toBeNull();
  expect(test.view.queryByLabelText('線の始点',{exact:true})).toBeNull();
});

it.each([['line','線の始点','線の終点'],['arrow','矢印の根元','矢印の先端']] as const)('offers endpoint handles instead of the box for %s',(kind,startLabel,endLabel)=>{
  const test=fixture(undefined,undefined,{element:kind});
  // 端点型では四隅・移動の箱を出さない（当たり判定が重なると掴む点を選べない）。
  expect(test.handle).toBeNull();expect(test.view.container.querySelector('polygon')).toBeNull();
  expect(test.view.getByLabelText(startLabel,{exact:true})).toBeTruthy();
  expect(test.view.getByLabelText(endLabel,{exact:true})).toBeTruthy();
});

it('moves only the grabbed endpoint and commits the shape once',async()=>{
  const test=fixture(undefined,undefined,{element:'line'});
  await act(async()=>pointer(test.grab('線の終点'),'pointerdown',128,90));
  await act(async()=>pointer(window,'pointermove',288,36));
  const drawn=test.frames.at(-1)!.clips[0]!.content;if(drawn.kind!=='shape')throw new Error('fixture');
  expect(drawn.data).toMatchObject({x1:.1,y1:.2,x2:.9,y2:.2});
  await act(async()=>pointer(window,'pointerup',288,36));
  expect(test.commands).toHaveLength(0);
  expect(test.shapeCommands).toHaveLength(1);
  expect(test.shapeCommands[0]!.data).toMatchObject({x1:.1,y1:.2,x2:.9,y2:.2});
});

it('clicking off-center on a handle without moving does not nudge the endpoint',async()=>{
  // p2 の実座標は (128,90)。ヒット領域内 (128+5,90-4) を掴んでそのまま離す＝クリック相当。
  const test=fixture(undefined,undefined,{element:'line'});
  await act(async()=>pointer(test.grab('線の終点'),'pointerdown',133,86));
  await act(async()=>pointer(window,'pointerup',133,86));
  expect(test.shapeCommands).toHaveLength(0);
});

it('treats float round-trip noise in non-power-of-2 viewport as unchanged endpoint',async()=>{
  // vp.x=337.5, width=1097.5 の往復変換で浮動小数誤差が出る。x2=0.42 の場合:
  // client = 337.5 + 0.42*1097.5 = 798.75
  // (client - 337.5)/1097.5 = 461.25/1097.5 = 0.42000000000000004 ≠ 0.42
  const test=fixture(undefined,undefined,{element:'line',configure:(document)=>{
    if(document.clips[0]!.content.kind==='shape'){
      document.clips[0]!.content.data.x2=.42;
      document.clips[0]!.content.data.y2=.3;
    }
  }});
  test.setStageRect(337.5,1097.5,618.1875);
  // 端点 x2=0.42, y2=0.3 をクリック。移動なし。
  // 画面座標 ≈ 337.5 + 0.42*1097.5 = 798.75, 0.3*618.1875 = 185.45625
  await act(async()=>pointer(test.grab('線の終点'),'pointerdown',798.75,185.45625));
  await act(async()=>pointer(window,'pointerup',798.75,185.45625));
  // 浮動小数誤差があっても commitShape は走らない（未修正なら 1 件走る）
  expect(test.shapeCommands).toHaveLength(0);
});

it('keeps the grabbed offset while dragging instead of snapping the endpoint to the cursor',async()=>{
  const test=fixture(undefined,undefined,{element:'line'});
  await act(async()=>pointer(test.grab('線の終点'),'pointerdown',133,86));
  await act(async()=>pointer(window,'pointermove',173,56));
  const drawn=test.frames.at(-1)!.clips[0]!.content;if(drawn.kind!=='shape')throw new Error('fixture');
  // カーソルの生位置ではなく、掴んだオフセットぶんだけ元の端点から動く。
  expect((drawn.data as {x2:number}).x2).toBeCloseTo(.525,6);
  expect((drawn.data as {y2:number}).y2).toBeCloseTo(1/3,6);
  await act(async()=>pointer(window,'pointerup',173,56));
  expect(test.shapeCommands).toHaveLength(1);
  expect(test.shapeCommands[0]!.data).toMatchObject({x1:.1,y1:.2});
});

it('refuses an endpoint move that collapses a protractor side, without saving',async()=>{
  const test=fixture(undefined,undefined,{element:'angle'});
  expect(test.view.getByLabelText('角のもう一辺の先',{exact:true})).toBeTruthy();
  await act(async()=>pointer(test.grab('角の一辺の先'),'pointerdown',128,90));
  await act(async()=>pointer(window,'pointermove',32,36));
  await act(async()=>pointer(window,'pointerup',32,36));
  expect(test.shapeCommands).toHaveLength(0);
});

it.each(['Escape','pointercancel','blur'] as const)('cancels an endpoint drag on %s, restoring the original document and clearing busy',async kind=>{
  const test=fixture(undefined,undefined,{element:'line'});
  await act(async()=>pointer(test.grab('線の終点'),'pointerdown',128,90));
  await act(async()=>pointer(window,'pointermove',200,40));
  await act(async()=>{
    if(kind==='Escape')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    else if(kind==='pointercancel')pointer(window,'pointercancel',200,40);
    else window.dispatchEvent(new Event('blur'));
  });
  await act(async()=>pointer(window,'pointerup',200,40));
  expect(test.shapeCommands).toHaveLength(0);expect(test.commands).toHaveLength(0);
  expect(test.frames.at(-1)).toBeNull();expect(test.busy.at(-1)).toBe(false);
  // draftShape は破棄され、再描画は元の端点座標へ戻る。
  const handle=test.view.getByLabelText('線の終点',{exact:true});
  expect(Number(handle.getAttribute('x'))+7).toBeCloseTo(128,6);expect(Number(handle.getAttribute('y'))+7).toBeCloseTo(90,6);
});

it('keeps endpoint handles off a rotated shape',()=>{
  const test=fixture(undefined,undefined,{element:'line',configure:doc=>{doc.clips[0]!.visual!.layout.rotation=15;}});
  expect(test.view.queryByLabelText('線の始点',{exact:true})).toBeNull();
  expect(test.view.container.textContent).toContain('回転・反転');
});

it('shows a reason for missing measured text geometry without offering a gesture',()=>{
  const test=fixture(undefined,undefined,{element:'text',configure:(_,geometry)=>{geometry.elements=[];}});
  expect(test.handle).toBeNull();expect(test.view.container.textContent).toContain('操作範囲を取得できません');
});

it('accepts injected nonzero padding/background geometry for empty text',()=>{
  const test=fixture(undefined,undefined,{element:'text',configure:(doc,geometry)=>{
    const content=doc.clips[0]!.content;if(content.kind==='telop')content.data.text='';
    geometry.elements![0]!.localBounds={x:144,y:80,width:32,height:16};
  }});
  expect(test.view.container.querySelector('polygon')!.getAttribute('points')).toBe('144,80 176,80 176,96 144,96');
  expect(test.handle.hasAttribute('data-native-move-grip')).toBe(true);
});

it.each(['text','title'] as const)('does not begin after release while %s fonts are pending',async element=>{
  const fonts=deferred(),test=fixture(undefined,undefined,{element,draw:async()=>{await fonts.promise;}});
  await act(async()=>pointer(test.handle,'pointerdown',50,125));await act(async()=>pointer(window,'pointerup',80,125));
  await act(async()=>fonts.resolve(true));expect(test.commands).toHaveLength(0);expect(test.busy.at(-1)).toBe(false);
});

it.each(['inner-animation','enter','exit','motion'] as const)('explains unsupported title %s instead of starting a gesture',issue=>{
  const test=fixture(undefined,undefined,{element:'title',configure:doc=>{
    const visual=doc.clips[0]!.visual!;
    if(issue==='inner-animation'){delete visual.enter;delete visual.exit;}
    else if(issue==='motion')visual.motion={preset:'panLeft'};
    else visual[issue]={kind:'fade',frames:8};
  }});
  expect(test.handle).toBeNull();expect(test.view.container.textContent).toMatch(issue==='inner-animation'?/内側のアニメーション/:issue==='motion'?/動き/:/登場・退場/);
});

it('keeps title style/content and earlier keys when moving only the current position key',async()=>{
  const keys=[{frame:r(0),value:{position:{x:0,y:0}}},{frame:r(20),value:{position:{x:.2,y:0}}}];
  const test=fixture(undefined,undefined,{element:'title',configure:(doc,geometry)=>{
    doc.clips[0]!.visual!.keyframes=structuredClone(keys);doc.clips[0]!.visual!.motion={preset:'panLeft'};
    geometry.elements![0]!.transform.x=.1;
  }});
  await act(async()=>pointer(test.handle,'pointerdown',80,130));await act(async()=>pointer(window,'pointerup',112,130));
  expect(test.commands).toHaveLength(1);const visual=test.commands[0]!.changes[0]!.visual;
  expect(visual.layout.position).toEqual({x:0,y:0});expect(visual.keyframes.filter(key=>key.frame.num!==10)).toEqual(keys);
  expect(visual.keyframes.find(key=>key.frame.num===10)!.value.position!.x).toBeCloseTo(.3,12);
  expect(test.frames.find(value=>value)?.clips[0]!.content).toEqual({kind:'title',data:{text:'タイトル'},style:{top:20,left:15,fontSize:24}});
  for(const item of [test.frames.find(value=>value)!.clips[0]!.visual!,visual]){
    expect(item.enter).toEqual({kind:'none',frames:0});expect(item.exit).toEqual({kind:'none',frames:0});expect(item.motion).toEqual({preset:'panLeft'});
  }
});

it('accepts injected empty-title band geometry and restores canonical drawing on refusal',async()=>{
  const test=fixture(undefined,async()=>false,{element:'title',configure:(doc,geometry)=>{
    const content=doc.clips[0]!.content;if(content.kind==='title')content.data.text='';
    geometry.elements![0]!.localBounds={x:15,y:20,width:10,height:16};
  }});
  expect(test.view.container.querySelector('polygon')!.getAttribute('points')).toBe('15,20 25,20 25,36 15,36');
  expect(test.handle.hasAttribute('data-native-move-grip')).toBe(true);
  await act(async()=>pointer(test.handle,'pointerdown',20,25));await act(async()=>pointer(window,'pointerup',52,43));
  expect(test.commands).toHaveLength(1);expect(test.frames.at(-1)).toBeNull();
  expect(test.view.getByRole('status').textContent).toContain('保存できません');expect(test.busy.at(-1)).toBe(false);
});

it.each(['text','title','rect','ellipse'] as const)('cancels an external revision during %s manipulation',async element=>{
  const test=fixture(undefined,undefined,{element});await act(async()=>pointer(test.handle,'pointerdown',50,125));
  await act(async()=>pointer(window,'pointermove',80,125));await act(async()=>test.external());
  await act(async()=>pointer(window,'pointerup',80,125));expect(test.commands).toHaveLength(0);expect(test.frames.at(-1)).toBeNull();
});
it('does not let an old failed preparation cancel a newer live gesture',async()=>{
  const old=deferred(),next=deferred(),prepare=vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise),test=fixture(prepare);
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>pointer(window,'pointerup',100,80));
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>next.resolve(true));
  await act(async()=>pointer(window,'pointermove',132,98));
  expect(test.handle.closest('svg')!.getAttribute('data-native-manipulation')).toBe('dragging');
  await act(async()=>old.resolve(false));
  expect(test.handle.closest('svg')!.getAttribute('data-native-manipulation')).toBe('dragging');
  expect(test.busy.at(-1)).toBe(true);
  expect(test.frames.at(-1)?.clips[0]!.visual!.layout.position).toEqual({x:.2,y:.2});
  await act(async()=>pointer(window,'pointerup',132,98));
  expect(test.commands).toHaveLength(1);
  expect(test.commands[0]!.changes[0]!.visual.layout.position).toEqual({x:.2,y:.2});
});
it('passes Escape to Workspace during commit without cancelling the submitted command',async()=>{
  const wait=deferred(),test=fixture(undefined,()=>wait.promise),workspaceKey=vi.fn();
  window.addEventListener('keydown',workspaceKey);
  try{
    await act(async()=>pointer(test.handle,'pointerdown',100,80));
    await act(async()=>pointer(window,'pointerup',132,98));
    expect(test.handle.closest('svg')!.getAttribute('data-native-manipulation')).toBe('committing');
    const escape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});
    await act(async()=>test.handle.dispatchEvent(escape));
    expect(workspaceKey).toHaveBeenCalledWith(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(test.handle.closest('svg')!.getAttribute('data-native-manipulation')).toBe('committing');
    expect(test.commands).toHaveLength(1);expect(test.busy.at(-1)).toBe(true);
    await act(async()=>wait.resolve(true));
    expect(test.handle.closest('svg')!.getAttribute('data-native-manipulation')).toBe('idle');
    expect(test.commands).toHaveLength(1);expect(test.busy.at(-1)).toBe(false);
  }finally{window.removeEventListener('keydown',workspaceKey);wait.resolve(true);}
});
it.each([false,true])('renders moves provisionally and commits once on pointerup (image=%s)',async image=>{
  const test=fixture(undefined,undefined,{image});await act(async()=>pointer(test.handle,'pointerdown',100,80));
  await act(async()=>pointer(window,'pointermove',132,98));await act(async()=>pointer(window,'pointermove',164,116));
  expect(test.commands).toHaveLength(0);expect(test.frames.at(-1)?.clips[0]!.visual!.layout.position).toEqual({x:.4,y:.4});
  await act(async()=>pointer(window,'pointerup',164,116));expect(test.commands).toHaveLength(1);expect(test.commands[0]).toMatchObject({revision:1,frame:10,changes:[{clipId:'video',visual:{layout:{position:{x:.4,y:.4}}}}]});expect(test.frames.at(-1)).toBeNull();
});
it.each([false,true].flatMap(image=>(['Escape','pointercancel','flush','external'] as const).map(kind=>({image,kind}))))('cancels on $kind without a command (image=$image)',async({image,kind})=>{
  const test=fixture(undefined,undefined,{image});await act(async()=>pointer(test.handle,'pointerdown',100,80));await act(async()=>pointer(window,'pointermove',132,98));
  await act(async()=>{if(kind==='Escape')window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));else if(kind==='pointercancel')pointer(window,'pointercancel',132,98);else if(kind==='flush')expect(await test.ref.current!.flush()).toBe(true);else test.external();});
  await act(async()=>pointer(window,'pointerup',132,98));expect(test.commands).toHaveLength(0);expect(test.frames.at(-1)).toBeNull();expect(test.busy.at(-1)).toBe(false);
});
it('does not commit an unmoved pointer, and flush waits for an already submitted rejection',async()=>{
  const wait=deferred(),test=fixture(undefined,()=>wait.promise);
  await act(async()=>pointer(test.handle,'pointerdown',100,80));await act(async()=>pointer(window,'pointerup',100,80));expect(test.commands).toHaveLength(0);
  await act(async()=>pointer(test.handle,'pointerdown',100,80));await act(async()=>pointer(window,'pointerup',132,98));
  let finished=false;const flushed=test.ref.current!.flush().then(ok=>{finished=true;return ok;});await act(async()=>{});expect(finished).toBe(false);
  await act(async()=>wait.resolve(false));expect(await flushed).toBe(false);expect(test.frames.at(-1)).toBeNull();expect(test.view.getByRole('status').textContent).toContain('保存できません');expect(await test.ref.current!.flush()).toBe(true);
});
// レビュー I1: 吸着線ちょうどではない配置（許容 .02 内）で、実移動 0 のクリックだけをする。
// begin が move(active,active.last) を無条件で呼ぶため、旧実装は差分 0 でも吸着してしまい、
// finish の不変判定を抜けて commit してしまっていた。
it('吸着線から許容内だが線ちょうどではない配置は、クリックだけでは動かない',async()=>{
  const test=fixture(undefined,undefined,{configure:(doc,geometry)=>{
    doc.clips[0]!.visual!.layout.position={x:.015,y:0};
    geometry.videos![0]!.transform.x=.015;geometry.videos![0]!.transform.y=0;
  }});
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  expect(test.view.container.querySelectorAll('.native-preview-guide')).toHaveLength(0);
  await act(async()=>pointer(window,'pointerup',100,80));
  expect(test.commands).toHaveLength(0);
});
it('同じ配置でも 1px 動かせば吸着が働く',async()=>{
  const test=fixture(undefined,undefined,{configure:(doc,geometry)=>{
    doc.clips[0]!.visual!.layout.position={x:.015,y:0};
    geometry.videos![0]!.transform.x=.015;geometry.videos![0]!.transform.y=0;
  }});
  await act(async()=>pointer(test.handle,'pointerdown',100,80));
  // dx=-1px（viewport 320）→ 正規化 -.00625。.015-.00625=.00875 は 0 との差が許容 .02 内。
  await act(async()=>pointer(window,'pointermove',99,80));
  expect(test.view.container.querySelectorAll('.native-preview-guide.is-hit')).not.toHaveLength(0);
  await act(async()=>pointer(window,'pointerup',99,80));
  expect(test.commands).toHaveLength(1);
  expect(test.commands[0]!.changes[0]!.visual.layout.position).toEqual({x:0,y:0});
});
it('tracks committed stage dimensions without another document render',async()=>{
  const test=fixture();expect(test.handle.closest('svg')!.getAttribute('width')).toBe('320');
  await act(async()=>test.resize(160,90));
  expect(test.handle.closest('svg')!.getAttribute('width')).toBe('160');expect(test.handle.getAttribute('points')).toBe('0,0 160,0 160,90 0,90');
});
it('cancels a live drag when the composition changes size',async()=>{
  const test=fixture();await act(async()=>pointer(test.handle,'pointerdown',100,80));await act(async()=>pointer(window,'pointermove',132,98));
  await act(async()=>test.resize(160,90));await act(async()=>pointer(window,'pointerup',132,98));
  expect(test.commands).toHaveLength(0);expect(test.frames.at(-1)).toBeNull();expect(test.busy.at(-1)).toBe(false);expect(test.view.getByRole('status').textContent).toContain('表示サイズ');
});

it.each(['左上','右上','右下','左下'] as const)('resizes a rotated portrait image from %s with the opposite bitmap corner fixed',async corner=>{
  const test=fixture(undefined,undefined,{image:true,configure:(doc,geometry)=>{
    doc.clips[0]!.visual!.layout.rotation=30;geometry.images![0]!.transform.rotation=30;
  }});
  const signs={'左上':[-1,-1],'右上':[1,-1],'右下':[1,1],'左下':[-1,1]} as const;
  const [sx,sy]=signs[corner],cos=Math.sqrt(3)/2,sin=.5;
  const local={x:sx*45,y:sy*90},offset={x:cos*local.x-sin*local.y,y:sin*local.x+cos*local.y};
  const grab={x:160+offset.x,y:90+offset.y},anchor={x:160-offset.x,y:90-offset.y};
  const handle=test.view.getByLabelText(`画像の${corner}を拡縮`);
  Object.defineProperty(handle,'setPointerCapture',{value:()=>{}});
  expect(Number(handle.getAttribute('x'))+6).toBeCloseTo(grab.x,10);
  expect(Number(handle.getAttribute('y'))+6).toBeCloseTo(grab.y,10);
  const end={x:grab.x+offset.x*.5,y:grab.y+offset.y*.5};
  await act(async()=>pointer(handle,'pointerdown',grab.x,grab.y));
  await act(async()=>pointer(window,'pointermove',end.x,end.y));expect(test.commands).toHaveLength(0);
  await act(async()=>pointer(window,'pointerup',end.x,end.y));expect(test.commands).toHaveLength(1);
  const layout=test.commands[0]!.changes[0]!.visual.layout;
  expect(layout.scale).toBeCloseTo(1.25,10);expect(layout.rotation).toBe(30);
  const center={x:160*(1+layout.position.x),y:90*(1+layout.position.y)};
  expect(center.x-offset.x*layout.scale).toBeCloseTo(anchor.x,10);
  expect(center.y-offset.y*layout.scale).toBeCloseTo(anchor.y,10);
  expect(center.x+offset.x*layout.scale).toBeCloseTo(end.x,10);
  expect(center.y+offset.y*layout.scale).toBeCloseTo(end.y,10);
});
it('updates the current image key while preserving base placement and surrounding keys',async()=>{
  const keys=[{frame:r(0),value:{position:{x:0,y:0}}},{frame:r(20),value:{position:{x:.2,y:0}}}];
  const test=fixture(undefined,undefined,{image:true,configure:(doc,geometry)=>{
    doc.clips[0]!.visual!.keyframes=structuredClone(keys);geometry.images![0]!.transform.x=.1;
  }});
  await act(async()=>pointer(test.handle,'pointerdown',160,90));
  await act(async()=>pointer(window,'pointerup',192,90));
  const visual=test.commands[0]!.changes[0]!.visual;
  expect(visual.layout.position).toEqual({x:0,y:0});
  expect(visual.keyframes.filter(key=>key.frame.num!==10)).toEqual(keys);
  expect(visual.keyframes.find(key=>key.frame.num===10)?.value.position?.x).toBeCloseTo(.3,12);
});
it('does not start an image gesture after pointerup during image decoding',async()=>{
  const decoding=deferred(),test=fixture(undefined,undefined,{image:true,draw:async()=>{await decoding.promise;}});
  await act(async()=>pointer(test.handle,'pointerdown',160,90));
  expect(test.handle.closest('svg')!.getAttribute('data-native-manipulation')).toBe('preparing');
  await act(async()=>pointer(window,'pointerup',192,90));
  await act(async()=>decoding.resolve(true));
  expect(test.handle.closest('svg')!.getAttribute('data-native-manipulation')).toBe('idle');
  expect(test.commands).toHaveLength(0);expect(test.busy.at(-1)).toBe(false);
});
it('reports failed image decoding and permits a later successful gesture',async()=>{
  const draw=vi.fn().mockRejectedValueOnce(new Error('画像を読み込めません')).mockResolvedValue(undefined);
  const test=fixture(undefined,undefined,{image:true,draw});
  await act(async()=>pointer(test.handle,'pointerdown',160,90));
  expect(test.view.getByRole('status').textContent).toContain('画像を読み込めません');
  expect(test.commands).toHaveLength(0);expect(test.busy.at(-1)).toBe(false);
  await act(async()=>pointer(test.handle,'pointerdown',160,90));
  await act(async()=>pointer(window,'pointerup',192,90));expect(test.commands).toHaveLength(1);
});
it.each(['photo','infographic','overlay','component','flipH','flipV'] as const)('does not offer image gestures for unsupported %s',kind=>{
  const test=fixture(undefined,undefined,{image:true,configure:doc=>{
    if(kind==='component')doc.rendering={imageComponentAssetId:'custom',telopBottomOffset:null,telopFontSize:null};
    else if(kind==='flipH'||kind==='flipV')doc.clips[0]!.visual!.layout[kind]=true;
    else{const content=doc.clips[0]!.content;if(content.kind==='image')content.style=kind;}
  }});
  expect(test.view.queryByLabelText('選択した画像を移動')).toBeNull();
  expect(test.view.container.textContent).toMatch(kind==='component'?/持ち込み部品/:kind.startsWith('flip')?/反転/:/そのまま/);
});

// T20: 複数選択のまとめドラッグ。箱は基準の 1 件目に出し、動くのは選択全部。
// clip1 の箱は (20,110)-(120,150)、clip2 は (180,20)-(240,50)。合成面 320x180 で 1px=1px。
const group=(options:{element?:'rect'|'line';selected?:string[];third?:boolean;snapEnabled?:boolean}={})=>fixture(undefined,undefined,{
  element:options.element??'rect',selected:options.selected??['video','second'],snapEnabled:options.snapEnabled,
  configure:(doc,geometry)=>{
    doc.clips.push({...structuredClone(doc.clips[0]!),id:'second',name:'図形2'});
    doc.clips[1]!.visual!.layout.position={x:-.32,y:0};
    geometry.elements!.push({...structuredClone(geometry.elements![0]!),clipId:'second',
      localBounds:{x:180,y:20,width:60,height:30},transform:{...geometry.elements![0]!.transform,x:-.32}});
    if(options.third){
      // 表示時間外＝直接操作できない 1 件。除外して残りで操作を続ける。
      doc.clips.push({...structuredClone(doc.clips[0]!),id:'third',name:'図形3',startFrame:50});
    }
  }});

it('複数選択を 1 コマンドでまとめて移動する（相対位置を保つ）',async()=>{
  const test=group();
  expect(test.handle.getAttribute('points')).toBe('20,110 120,110 120,150 20,150');
  await act(async()=>pointer(test.handle,'pointerdown',50,125));
  await act(async()=>pointer(window,'pointermove',82,143));
  expect(test.commands).toHaveLength(0);
  expect(test.frames.at(-1)!.clips[0]!.visual!.layout.position).toEqual({x:.2,y:.2});
  expect(test.frames.at(-1)!.clips[1]!.visual!.layout.position.x).toBeCloseTo(-.12,10);
  expect(test.frames.at(-1)!.clips[1]!.visual!.layout.position.y).toBeCloseTo(.2,10);
  await act(async()=>pointer(window,'pointerup',82,143));
  expect(test.commands).toHaveLength(1);
  expect(test.commands[0]!.changes.map(item=>item.clipId)).toEqual(['video','second']);
  expect(test.commands[0]!.changes[1]!.visual.layout.position.x).toBeCloseTo(-.12,10);
});

it('吸着は基準の 1 件で判定し、補正量を全員へ同じだけ足す',async()=>{
  const test=group();
  await act(async()=>pointer(test.handle,'pointerdown',50,125));
  // dx=53px → 0.33125。1/3 との差 0.002 は許容 0.02 内なので基準が 1/3 へ吸い付く。
  await act(async()=>pointer(window,'pointermove',103,143));
  const moved=test.frames.at(-1)!.clips;
  expect(moved[0]!.visual!.layout.position.x).toBeCloseTo(1/3,12);
  // 個別に吸着させると 0.01125 が 0 へ落ちて相対位置が崩れる。同じ補正量なので -0.32+1/3。
  expect(moved[1]!.visual!.layout.position.x).toBeCloseTo(-.32+1/3,12);
  const hit=[...test.view.container.querySelectorAll('.native-preview-guide.is-hit')];
  expect(hit).toHaveLength(1);expect(hit[0]!.getAttribute('data-native-snap-guide')).toBe('x');
  expect(test.view.container.querySelectorAll('.native-preview-guide')).toHaveLength(6);
});

it('直接操作できない要素は除外して通知し、残りで操作を続ける',async()=>{
  const test=group({selected:['video','second','third'],third:true});
  await act(async()=>pointer(test.handle,'pointerdown',50,125));
  await act(async()=>pointer(window,'pointermove',82,143));
  expect(test.view.getByRole('status').textContent).toContain('1件は直接操作できない');
  await act(async()=>pointer(window,'pointerup',82,143));
  expect(test.commands).toHaveLength(1);
  expect(test.commands[0]!.changes.map(item=>item.clipId)).toEqual(['video','second']);
});

it('複数選択では端点ハンドルを出さない（箱だけ）',()=>{
  const test=group({element:'line'});
  expect(test.view.queryByLabelText('線の始点')).toBeNull();
  expect(test.view.queryByLabelText('線の終点')).toBeNull();
  expect(test.view.container.querySelector('polygon')).not.toBeNull();
});

// レビュー M4/M5: 端点図形（線・矢印・角）だけの複数選択は、実際には外接箱（geometry.elements）を
// 持たない（begin の boxIds 除外と同じ前提）。掴める箱もハンドルも無いのに
// 「ドラッグで移動・四隅で拡縮」と案内しないことを確かめる。
it('端点図形だけの複数選択は、掴める操作枠が無いことを案内する',()=>{
  const test=fixture(undefined,undefined,{element:'line',selected:['video','second'],configure:(doc,geometry)=>{
    doc.clips.push({...structuredClone(doc.clips[0]!),id:'second',name:'線2'});
    // 実際のジオメトリは端点図形の外接箱を作らない（begin() 側の前提と同じ）。
    geometry.elements=[];
  }});
  expect(test.view.container.querySelector('polygon')).toBeNull();
  expect(test.view.queryByLabelText('線の始点')).toBeNull();
  expect(test.view.container.textContent).toContain('端点で動かす図形は1つだけ選ぶと操作できます。');
});

it('ガイド線はドラッグ中だけ出す',async()=>{
  const test=group();
  expect(test.view.container.querySelectorAll('.native-preview-guide')).toHaveLength(0);
  await act(async()=>pointer(test.handle,'pointerdown',50,125));
  await act(async()=>pointer(window,'pointermove',82,143));
  expect(test.view.container.querySelectorAll('.native-preview-guide')).toHaveLength(6);
  await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  expect(test.view.container.querySelectorAll('.native-preview-guide')).toHaveLength(0);
  expect(test.commands).toHaveLength(0);
});

// レビュー I3: 複数選択の四隅拡縮に統合テストが無い。外接矩形の中心（合成面ローカル原点で計算）を
// 基準に同じ倍率が両要素へ掛かることを確認する。ステージへ非ゼロのオフセットを与えているのは、
// 拡縮の基準を誤って active.viewport（client 原点）へ戻す退行を検出するため——その退行では
// cx,cy が本テストの期待値からずれて落ちる。
it('複数選択の四隅拡縮は外接矩形の中心を基準に同じ倍率を掛ける',async()=>{
  const test=group();
  await act(async()=>test.setStageRect(50,320,180));
  const handle=test.view.getByLabelText('図形の右下を拡縮');
  Object.defineProperty(handle,'setPointerCapture',{value:()=>{}});
  await act(async()=>pointer(handle,'pointerdown',170,150));
  await act(async()=>pointer(window,'pointermove',190,170));
  await act(async()=>pointer(window,'pointerup',190,170));
  expect(test.commands).toHaveLength(1);
  const [video,second]=test.commands[0]!.changes;
  expect(video!.clipId).toBe('video');expect(second!.clipId).toBe('second');
  const ratio=video!.visual.layout.scale;
  expect(ratio).not.toBeCloseTo(1,6);
  expect(second!.visual.layout.scale).toBeCloseTo(ratio,10);
  // second は開始時点で position.x=-.32 を持つため、外接矩形は localBounds そのものではなく、
  // previewVideoCorners が placement を適用した後の実クライアント座標（second: nw(128.8,20)-se(188.8,50)、
  // video: (20,110)-(120,150)）の外接。中心 (104.4,85) を 320x180 の正規化座標へ写した値。
  const cx=104.4/320*2-1,cy=85/180*2-1;
  expect(video!.visual.layout.position.x).toBeCloseTo(cx+(0-cx)*ratio,10);
  expect(video!.visual.layout.position.y).toBeCloseTo(cy+(0-cy)*ratio,10);
  expect(second!.visual.layout.position.x).toBeCloseTo(cx+(-.32-cx)*ratio,10);
  expect(second!.visual.layout.position.y).toBeCloseTo(cy+(0-cy)*ratio,10);
});

it.each(['toggle','alt'] as const)('吸着はタイムラインのスナップと Alt に従う（%s で切る）',async gate=>{
  const test=group(gate==='toggle'?{snapEnabled:false}:{});
  if(gate==='alt')await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Alt',bubbles:true})));
  try{
    await act(async()=>pointer(test.handle,'pointerdown',50,125));
    await act(async()=>pointer(window,'pointermove',103,143));
    // 吸着が効いていれば 1/3 へ寄る。切れているので指の位置そのまま。
    expect(test.frames.at(-1)!.clips[0]!.visual!.layout.position.x).toBeCloseTo(.33125,12);
    expect(test.view.container.querySelectorAll('.native-preview-guide')).toHaveLength(0);
  }finally{if(gate==='alt')await act(async()=>window.dispatchEvent(new KeyboardEvent('keyup',{key:'Alt',bubbles:true})));}
});

// M-6: サーバーの 1 リクエスト 50 リーフ上限に当たると「まとめる編集操作が多すぎます」という
// 文脈外の文言でドラッグの最後に落ちる。掴む前に、同じ値で断る。
it('refuses a bulk drag past the server leaf limit before anything is grabbed',()=>{
  const ids=Array.from({length:MAX_SEQUENCE_COMMAND_LEAVES+1},(_,index)=>`clip-${index}`);
  const test=fixture(undefined,undefined,{selected:ids,configure:(document,geometry)=>{
    for(const id of ids){
      document.clips.push({...structuredClone(document.clips[0]!),id});
      geometry.videos!.push({...structuredClone(geometry.videos![0]!),clipId:id});
    }
  }});
  expect(test.view.container.querySelector('.native-manipulation-note')!.textContent)
    .toBe(`一度に動かせるのは ${MAX_SEQUENCE_COMMAND_LEAVES} 件までです。選ぶ数を減らしてから操作してください。`);
  expect(test.view.queryByLabelText('選択した映像を移動')).toBeNull();
  // 上限ちょうどは従来どおり操作できる。
  const ok=Array.from({length:MAX_SEQUENCE_COMMAND_LEAVES},(_,index)=>`clip-${index}`);
  const allowed=fixture(undefined,undefined,{selected:ok,configure:(document,geometry)=>{
    for(const id of ok){
      document.clips.push({...structuredClone(document.clips[0]!),id});
      geometry.videos!.push({...structuredClone(geometry.videos![0]!),clipId:id});
    }
  }});
  expect(allowed.view.container.querySelector('.native-manipulation-note')!.textContent)
    .toContain(`${MAX_SEQUENCE_COMMAND_LEAVES}件をまとめて操作`);
});

// T20 Minor: ビューポート未測定（幅 0）は「掴めない」ではなく「まだ測れていない」。
it('does not claim an endpoint-only restriction while the preview has no measured size',()=>{
  const test=fixture(undefined,undefined,{element:'rect'});
  act(()=>{test.resize(0,0);});
  expect(test.view.container.querySelector('.native-manipulation-note')!.textContent)
    .not.toContain('端点で動かす図形は1つだけ');
});

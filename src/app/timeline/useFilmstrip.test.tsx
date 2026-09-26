/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,renderHook} from '@testing-library/react';
import {useFilmstripFrames} from './useFilmstrip';

afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();});
function media(){
 vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
 const videos:HTMLVideoElement[]=[],create=document.createElement.bind(document);
 vi.spyOn(document,'createElement').mockImplementation(((name:string,options?:ElementCreationOptions)=>{
  const node=create(name,options);
  if(name==='video'){Object.defineProperties(node,{duration:{value:10.123},videoWidth:{value:640},videoHeight:{value:360},readyState:{value:2}});videos.push(node as HTMLVideoElement);}
  return node;
 }) as typeof document.createElement);
 const draw=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);
 let n=0;vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockImplementation(()=>`data:image/jpeg;base64,image${++n}`);
 return {videos,draw,load(index=0){act(()=>videos[index]!.dispatchEvent(new Event('loadeddata')));},seek(index=0){act(()=>videos[index]!.dispatchEvent(new Event('seeked')));}};
}
it('seeks exact source seconds without whole-frame or duration-ratio rounding',()=>{
 const m=media(),fps=30000/1001;
 renderHook(()=>useFilmstripFrames('source',304,[1.017*fps],{sourceFps:fps,ownerKey:'a'}));
 m.load();expect(m.videos[0]!.currentTime).toBeCloseTo(1.017,12);
});
it('hides prior owner images during the first render and ignores late cancelled seeks',()=>{
 const m=media(),seen:number[]=[];
 const view=renderHook(({owner})=>{const result=useFilmstripFrames('source',300,[30],{sourceFps:30,ownerKey:owner});seen.push(result.length);return result;},{initialProps:{owner:'a'}});
 m.load();m.seek();expect(view.result.current).toHaveLength(1);seen.length=0;
 view.rerender({owner:'b'});expect(seen[0]).toBe(0);expect(view.result.current).toEqual([]);
 m.seek(0);expect(view.result.current).toEqual([]);m.load(1);m.seek(1);expect(view.result.current).toHaveLength(1);
});
it('preserves the legacy whole-frame, duration-relative caller behavior',()=>{
 const m=media();const view=renderHook(()=>useFilmstripFrames('source',300,[30.9,30.1]));m.load();
 expect(m.videos[0]!.currentTime).toBeCloseTo(10.123/10);m.seek();expect(view.result.current.map(f=>f.frame)).toEqual([30]);
});
it('clears URL changes and unmounts without accepting an old in-flight seek',()=>{
 const m=media(),view=renderHook(({url})=>useFilmstripFrames(url,300,[30,60],{sourceFps:30}),{initialProps:{url:'a' as string|null}});
 m.load();m.seek();expect(view.result.current).toHaveLength(1);view.rerender({url:'b'});m.seek(0);expect(view.result.current).toEqual([]);
 expect(m.videos[0]!.hasAttribute('src')).toBe(false);view.rerender({url:null});expect(m.videos[1]!.hasAttribute('src')).toBe(false);view.unmount();
});
it('bounds each request to 24 frames and evicts previous offscreen cache entries',()=>{
 const m=media(),view=renderHook(({frames})=>useFilmstripFrames('source',300,frames,{sourceFps:30}),{initialProps:{frames:Array.from({length:60},(_,i)=>i+1)}});
 m.load();for(let i=0;i<24;i++)m.seek();expect(view.result.current).toHaveLength(24);expect(m.draw).toHaveBeenCalledTimes(24);
 view.rerender({frames:[90]});m.load(1);m.seek(1);expect(view.result.current.map(f=>f.frame)).toEqual([90]);
 view.rerender({frames:[1]});expect(view.result.current).toEqual([]);expect(m.videos).toHaveLength(3);
});
it('times out unavailable resources and ignores errors and late events',()=>{
 vi.useFakeTimers();const m=media(),view=renderHook(()=>useFilmstripFrames('source',300,[30],{sourceFps:30}));
 act(()=>vi.advanceTimersByTime(8000));m.load();m.seek();expect(view.result.current).toEqual([]);expect(m.videos[0]!.hasAttribute('src')).toBe(false);
});
it('releases decoded media after success and errors without painting late callbacks',()=>{
 const m=media(),view=renderHook(({url})=>useFilmstripFrames(url,300,[30],{sourceFps:30}),{initialProps:{url:'a'}});
 m.load();m.seek();expect(view.result.current).toHaveLength(1);expect(m.videos[0]!.hasAttribute('src')).toBe(false);
 view.rerender({url:'b'});m.load(1);act(()=>m.videos[1]!.dispatchEvent(new Event('error')));m.seek(1);
 expect(view.result.current).toEqual([]);expect(m.videos[1]!.hasAttribute('src')).toBe(false);
});
it('handles an already decoded zero-time sample without waiting for a seeked event',()=>{
 const m=media(),view=renderHook(()=>useFilmstripFrames('source',300,[0],{sourceFps:30}));m.load();expect(view.result.current.map(f=>f.frame)).toEqual([0]);
});
it('rejects out of range exact samples instead of silently choosing another time',()=>{
 const m=media();const view=renderHook(()=>useFilmstripFrames('source',600,[-1,600,NaN,450],{sourceFps:30}));m.load();
 expect(view.result.current).toEqual([]);expect(m.draw).not.toHaveBeenCalled();
});

/** @vitest-environment jsdom */
import {afterEach,it,expect} from 'vitest';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {NumberField,TextField,ColorField,SelectField,CheckField,InspectorDraftContext} from './NativeInspectorFields';
afterEach(cleanup);
it('shares numeric and slider drafts and commits a drag only once on release',async()=>{
  const values:number[]=[],view=render(<NumberField label="不透明度" value={100} min={0} max={100} onCommit={v=>{values.push(v);return true;}}/>);
  const slider=view.getByRole('slider',{name:'不透明度を調整'}),number=view.getByRole('spinbutton',{name:'不透明度'});
  fireEvent.change(slider,{target:{value:'42'}});expect((number as HTMLInputElement).value).toBe('42');expect(values).toEqual([]);
  await act(async()=>{fireEvent.pointerUp(slider);fireEvent.blur(slider);});expect(values).toEqual([42]);
});
it('cancels a slider draft with Escape before a save or tab switch',async()=>{
  const values:number[]=[],view=render(<NumberField label="位置" value={0} min={-100} max={100} onCommit={v=>{values.push(v);return true;}}/>);
  const slider=view.getByRole('slider',{name:'位置を調整'});slider.focus();fireEvent.change(slider,{target:{value:'30'}});
  fireEvent.keyDown(slider,{key:'Escape'});expect(values).toEqual([]);expect((view.getByRole('spinbutton') as HTMLInputElement).value).toBe('0');
});
const deferred=()=>{let resolve!:(value:boolean)=>void;const promise=new Promise<boolean>(done=>{resolve=done;});return {promise,resolve};};
it('keeps a newer numeric draft while the previous commit is accepted',async()=>{
  const first=deferred(),onCommit=()=>first.promise;
  const view=render(<NumberField label="位置" value={0} onCommit={onCommit}/>),input=view.getByLabelText('位置') as HTMLInputElement;
  fireEvent.change(input,{target:{value:'10'}});fireEvent.blur(input);
  input.focus();fireEvent.change(input,{target:{value:'20'}});
  view.rerender(<NumberField label="位置" value={10} onCommit={onCommit}/>);
  await act(async()=>first.resolve(true));expect(input.value).toBe('20');expect(document.activeElement).toBe(input);
});
it('records a second explicit commit of the same pending value even if the first is rejected',async()=>{
  const first=deferred(),values:number[]=[];
  const view=render(<NumberField label="位置" value={0} onCommit={value=>{values.push(value);return values.length===1?first.promise:Promise.resolve(true);}}/>),input=view.getByLabelText('位置') as HTMLInputElement;
  fireEvent.change(input,{target:{value:'55'}});fireEvent.blur(input);
  fireEvent.change(input,{target:{value:'5'}});fireEvent.change(input,{target:{value:'55'}});fireEvent.blur(input);
  await act(async()=>first.resolve(false));expect(values).toEqual([55,55]);expect(input.value).toBe('55');
});
it('does not send rounded unchanged values or Escape cancellation',async()=>{
  const values:number[]=[],view=render(<NumberField label="位置" value={1/3} onCommit={value=>{values.push(value);}}/>),input=view.getByLabelText('位置') as HTMLInputElement;
  input.focus();fireEvent.blur(input);fireEvent.change(input,{target:{value:'8'}});fireEvent.keyDown(input,{key:'Escape'});fireEvent.blur(input);
  expect(values).toEqual([]);expect(input.value).toBe('0.333333');
});
it.each(['text','color'] as const)('preserves new %s draft across an old rejection and retries it',async kind=>{
  const first=deferred(),values:string[]=[],initial=kind==='text'?'old':'#000000',one=kind==='text'?'first':'#111111',two=kind==='text'?'second':'#222222';
  const onCommit=(value:string)=>{values.push(value);return values.length===1?first.promise:Promise.resolve(true);};
  const view=render(kind==='text'?<TextField value={initial} onCommit={onCommit}/>:<ColorField label="色" value={initial} onCommit={onCommit}/>),input=view.getByLabelText(kind==='text'?'テキスト':'色') as HTMLInputElement;
  fireEvent.change(input,{target:{value:one}});fireEvent.blur(input);input.focus();fireEvent.change(input,{target:{value:two}});
  await act(async()=>first.resolve(false));expect(input.value).toBe(two);expect(document.activeElement).toBe(input);
  await act(async()=>fireEvent.blur(input));expect(values).toEqual([one,two]);
});
it('keeps a native select optimistic while pending and restores the confirmed value on rejection',async()=>{
  const first=deferred(),view=render(<SelectField label="形" value="rect" onCommit={()=>first.promise}><option value="rect">四角</option><option value="ellipse">楕円</option></SelectField>),select=view.getByLabelText('形') as HTMLSelectElement;
  select.focus();fireEvent.change(select,{target:{value:'ellipse'}});expect(select.value).toBe('ellipse');
  await act(async()=>first.resolve(false));expect(select.value).toBe('rect');expect(document.activeElement).toBe(select);
});
it('preserves two rapid checkbox toggles while the first save is pending',async()=>{
  const first=deferred(),second=deferred(),values:boolean[]=[],dirty:boolean[]=[];
  const view=render(<InspectorDraftContext.Provider value={(_,value)=>dirty.push(value)}><CheckField label="反転" value={false} onCommit={value=>{values.push(value);return values.length===1?first.promise:second.promise;}}/></InspectorDraftContext.Provider>),input=view.getByLabelText('反転') as HTMLInputElement;
  fireEvent.click(input);expect(input.checked).toBe(true);fireEvent.click(input);expect(input.checked).toBe(false);expect(values).toEqual([true,false]);expect(dirty.at(-1)).toBe(false);
  await act(async()=>first.resolve(true));expect(input.checked).toBe(false);await act(async()=>second.resolve(true));expect(input.checked).toBe(false);
});
it('reconciles the latest failed commit even when callbacks settle out of order',async()=>{
  const first=deferred(),second=deferred(),values:number[]=[];
  const view=render(<NumberField label="位置" value={0} onCommit={value=>{values.push(value);return values.length===1?first.promise:second.promise;}}/>),input=view.getByLabelText('位置') as HTMLInputElement;
  fireEvent.change(input,{target:{value:'10'}});fireEvent.blur(input);fireEvent.change(input,{target:{value:'20'}});fireEvent.blur(input);
  await act(async()=>second.resolve(false));await act(async()=>first.resolve(true));expect(input.value).toBe('0');
});
it('keeps a newer numeric draft when an older commit is rejected, then allows retry',async()=>{
  const first=deferred(),values:number[]=[];
  const view=render(<NumberField label="位置" value={0} onCommit={value=>{values.push(value);return values.length===1?first.promise:Promise.resolve(true);}}/>),input=view.getByLabelText('位置') as HTMLInputElement;
  fireEvent.change(input,{target:{value:'10'}});fireEvent.blur(input);input.focus();fireEvent.change(input,{target:{value:'20'}});
  await act(async()=>first.resolve(false));expect(input.value).toBe('20');
  await act(async()=>fireEvent.blur(input));expect(values).toEqual([10,20]);expect(input.value).toBe('20');
});
// M-5': 変換中の Esc は「変換の取り消し」で、下書きを捨てる操作ではない（日本語入力で下書きが巻き戻るバグ）。
it('keeps the draft when Escape arrives while the IME is composing',()=>{
  const values:number[]=[],view=render(<NumberField label="位置" value={0} min={-100} max={100} onCommit={v=>{values.push(v);return true;}}/>);
  const input=view.getByRole('spinbutton',{name:'位置'}) as HTMLInputElement;
  input.focus();fireEvent.change(input,{target:{value:'30'}});
  fireEvent.keyDown(input,{key:'Escape',isComposing:true});
  expect(input.value).toBe('30');                                   // 変換中なので下書きは残る
  expect(document.activeElement).toBe(input);                       // blur もしない
  fireEvent.keyDown(input,{key:'Escape'});
  expect(input.value).toBe('0');                                    // 存在検査: 変換していない Esc では戻る
  expect(values).toEqual([]);
});
// M-8: TextField（textarea）でも同じ保証を固定する。長文の下書きが変換中の Esc で巻き戻らないこと。
it('TextField（textarea）も変換中の Escape では下書きを残す',()=>{
  const values:string[]=[],view=render(<TextField value="元の文" onCommit={v=>{values.push(v);return true;}}/>);
  const input=view.getByLabelText('テキスト') as HTMLTextAreaElement;
  input.focus();fireEvent.change(input,{target:{value:'書きかけの文'}});
  fireEvent.keyDown(input,{key:'Escape',isComposing:true});
  expect(input.value).toBe('書きかけの文');                          // 変換中なので下書きは残る
  expect(document.activeElement).toBe(input);                       // blur もしない
  fireEvent.keyDown(input,{key:'Escape'});
  expect(input.value).toBe('元の文');                                // 存在検査: 変換していない Esc では戻る
  expect(values).toEqual([]);
});

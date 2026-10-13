/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NativeLibraryPanel} from './NativeLibraryPanel';
import {type LibraryListing} from './libraryApi';
afterEach(()=>cleanup());
const listing=(over:Partial<{missing:string[]}>={}):LibraryListing=>({ok:true,directory:'/lib',missing:over.missing??[],catalog:{version:2,packs:[],
  templates:[{key:'tpl:m:1',packId:'m',template:1,name:'ふわっと出る',group:'g',use:'強調したい所に',preview:'p.png',sample:'見本',durationSec:2}],
  media:[{key:'se:aa',kind:'se',name:'ポン',desc:'軽い音',file:'se/a.wav',fingerprint:'aa',durationSec:1.5},
    {key:'img:bb',kind:'image',name:'矢印',desc:'',file:'img/b.png',preview:'img/b.png',fingerprint:'bb'}]}});
const props=(l:LibraryListing|null=listing())=>({listing:l,loading:false,playingKey:null as string|null,onAudition:vi.fn(),onPlace:vi.fn(),onReload:vi.fn()});
const names=(v:ReturnType<typeof render>)=>[...v.container.querySelectorAll('[data-library-key]')].map(n=>n.getAttribute('data-library-key'));
it('renders cards, filters by kind and searches',()=>{
  const v=render(<NativeLibraryPanel {...props()}/>);
  expect(names(v)).toEqual(['tpl:m:1','se:aa','img:bb']);
  fireEvent.click(v.getByRole('radio',{name:'効果音'}));expect(names(v)).toEqual(['se:aa']);
  fireEvent.click(v.getByRole('radio',{name:'すべて'}));
  fireEvent.change(v.getByRole('searchbox'),{target:{value:'ポン'}});expect(names(v)).toEqual(['se:aa']);
  fireEvent.change(v.getByRole('searchbox'),{target:{value:'強調'}});expect(names(v)).toEqual(['tpl:m:1']);
  fireEvent.change(v.getByRole('searchbox'),{target:{value:'軽い'}});expect(names(v)).toEqual(['se:aa']);
});
it('places on click and auditions sounds',()=>{
  const p=props();const v=render(<NativeLibraryPanel {...p}/>);
  fireEvent.click(v.getByRole('button',{name:'ポンを再生位置に置く'}));expect(p.onPlace).toHaveBeenCalledWith('se:aa');
  fireEvent.click(v.getByRole('button',{name:'ポンを試聴'}));expect(p.onAudition).toHaveBeenCalledWith('se:aa');expect(p.onPlace).toHaveBeenCalledTimes(1);
});
it('sets the library drag type on drag start',()=>{
  const v=render(<NativeLibraryPanel {...props()}/>);const setData=vi.fn();
  fireEvent.dragStart(v.container.querySelector('[data-library-key="tpl:m:1"] .native-lib-place')!,{dataTransfer:{setData}});
  expect(setData).toHaveBeenCalledWith('application/x-harness-library-item','tpl:m:1');
});
it('shows the reason and folder when the library is missing',()=>{
  const p=props({ok:false,directory:'/Users/x/素材置場',reason:'catalog.json がありません'});const v=render(<NativeLibraryPanel {...p}/>);
  expect(v.getByText(/catalog\.json がありません/)).toBeTruthy();expect(v.getByText(/\/Users\/x\/素材置場/)).toBeTruthy();
  fireEvent.click(v.getByRole('button',{name:'再読み込み'}));expect(p.onReload).toHaveBeenCalled();
});
it('disables missing items',()=>{
  const p=props(listing({missing:['se:aa']}));const v=render(<NativeLibraryPanel {...p}/>);
  expect(v.getByText('見つかりません')).toBeTruthy();
  const place=v.getByRole('button',{name:'ポンを再生位置に置く'}) as HTMLButtonElement;expect(place.disabled).toBe(true);fireEvent.click(place);expect(p.onPlace).not.toHaveBeenCalled();
  expect(v.container.querySelector('[data-library-key="se:aa"] .native-lib-place')!.getAttribute('draggable')).toBe('false');
});
it('shows loading',()=>{const v=render(<NativeLibraryPanel {...props(null)} loading/>);expect(v.getByRole('status').textContent).toContain('読み込んで');});
it('disables placing while locked or placing, but not auditioning',()=>{
  const p={...props(),disabled:true,busyKeys:[] as string[]};const v=render(<NativeLibraryPanel {...p}/>);
  fireEvent.click(v.getByRole('button',{name:'ポンを再生位置に置く'}));expect(p.onPlace).not.toHaveBeenCalled();
  fireEvent.click(v.getByRole('button',{name:'ポンを試聴'}));expect(p.onAudition).toHaveBeenCalled();
  v.rerender(<NativeLibraryPanel {...p} disabled={false} busyKeys={['se:aa']}/>);
  expect((v.getByRole('button',{name:'ポンを再生位置に置く'}) as HTMLButtonElement).disabled).toBe(true);
  expect(v.container.querySelector('[data-library-key="se:aa"]')!.getAttribute('data-busy')).toBe('true');expect(v.getByText('配置中…')).toBeTruthy();
});

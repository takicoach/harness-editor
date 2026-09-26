/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NativeViewMenu} from './NativeViewMenu';

afterEach(()=>{cleanup();vi.restoreAllMocks();});

/** タイムライン最小高さ（180px）の中で「表示」を開いても、メニューは overflow:hidden に切られる祖先の外へ出ている必要がある。 */
function renderInClippedPanel(){
  const host=window.document.createElement('div');host.className='native-workspace';
  window.document.body.append(host);
  const mount=host.appendChild(window.document.createElement('div'));
  const view=render(<div className="native-timeline-panel" style={{overflow:'hidden'}}>
    <NativeViewMenu><button>ズーム</button><button>全体</button></NativeViewMenu>
  </div>,{container:mount,baseElement:window.document.body});
  return {host,view};
}
const open=(view:ReturnType<typeof render>)=>{
  fireEvent.click(view.getByRole('button',{name:/表示/}));
  return view.getByRole('group',{name:'表示'});
};

it('opens the panel outside the clipped .native-timeline-panel ancestor, portaled into .native-workspace',()=>{
  const {host,view}=renderInClippedPanel();
  try{
    const panel=open(view);
    expect(panel.closest('.native-timeline-panel')).toBeNull();
    expect(panel.parentElement).toBe(host);
    // 存在検査: メニューは常に高々1個。
    expect(view.getAllByRole('group',{name:'表示'})).toHaveLength(1);
  }finally{host.remove();}
});
it('falls back to document.body when there is no .native-workspace ancestor',()=>{
  const view=render(<NativeViewMenu><button>ズーム</button></NativeViewMenu>);
  const panel=open(view);
  expect(panel.parentElement).toBe(window.document.body);
});
it('opens upward, keeping the panel top within the viewport, when the trigger sits near the bottom edge',()=>{
  const {host,view}=renderInClippedPanel();
  try{
    const trigger=view.getByRole('button',{name:/表示/});
    vi.spyOn(trigger,'getBoundingClientRect').mockReturnValue({
      top:window.innerHeight-40,bottom:window.innerHeight-8,left:600,right:680,width:80,height:32,x:600,y:window.innerHeight-40,toJSON(){return this;},
    } as DOMRect);
    const panel=open(view);
    // 上開きのときは top ではなく bottom で置く。その top 相当（viewport 上端からの距離）を逆算する。
    expect(panel.style.top).toBe('');
    const bottom=parseFloat(panel.style.bottom),maxHeight=parseFloat(panel.style.maxHeight);
    const effectiveTop=window.innerHeight-bottom-maxHeight;
    expect(effectiveTop).toBeGreaterThanOrEqual(0);
    expect(effectiveTop).toBeLessThan(window.innerHeight);
  }finally{host.remove();}
});
it('closes on Escape and returns focus to the trigger',()=>{
  const {host,view}=renderInClippedPanel();
  try{
    open(view);
    fireEvent.keyDown(window.document.body,{key:'Escape'});
    expect(view.queryByRole('group',{name:'表示'})).toBeNull();
    expect(window.document.activeElement).toBe(view.getByRole('button',{name:/表示/}));
  }finally{host.remove();}
});
it('closes when a pointer goes down outside the panel',()=>{
  const {host,view}=renderInClippedPanel();
  try{
    open(view);
    fireEvent.pointerDown(window.document.body);
    expect(view.queryByRole('group',{name:'表示'})).toBeNull();
  }finally{host.remove();}
});
it('focuses the first interactive element inside the panel when it opens',()=>{
  const {host,view}=renderInClippedPanel();
  try{
    open(view);
    expect(window.document.activeElement).toBe(view.getByRole('button',{name:'ズーム'}));
  }finally{host.remove();}
});

/** @vitest-environment jsdom */
import {cleanup,render,fireEvent,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('./notificationHistory',()=>({reportEditorError:vi.fn()}));
vi.mock('./api',()=>({nativeRequest:vi.fn(async()=>({assets:[{assetId:'a',name:'neuro-v3-source-1080.mp4',ready:true,recommended:true}]}))}));
import {NativeProxyBanner} from './NativeProxyBanner';
afterEach(cleanup);

it('軽量版が使えるときは 22px のチップ「軽量版あり」と「使う」ボタン（名前は旧名のまま）を見出しに出す',async()=>{
  const onReady=vi.fn();
  const view=render(<NativeProxyBanner projectId="p" sessionId="s" revision={1} onReady={onReady}/>);
  await waitFor(()=>expect(view.getByText('軽量版あり')).toBeTruthy());
  expect(view.container.querySelector('.native-notice')).toBeNull();
  expect(view.container.querySelector('.native-proxy-chip.is-ready')).toBeTruthy();
  fireEvent.click(view.getByRole('button',{name:'軽量版でプレビューを再読み込み'}));
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(view.getByRole('button',{name:'軽量版でプレビューを再読み込み'}).textContent).toBe('使う');
});

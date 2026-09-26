/** @vitest-environment jsdom */
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {NativeInspectorSection} from './NativeInspectorSection';
afterEach(cleanup);
it('keeps fields visible until drafts have finished and preserves mounted field state',async()=>{
  let finish!:(value:boolean)=>void;
  const close=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  const view=render(<NativeInspectorSection label="位置とサイズ" setting="layout" beforeClose={close}><input aria-label="draft" defaultValue="100"/></NativeInspectorSection>);
  fireEvent.change(view.getByLabelText('draft'),{target:{value:'125'}});
  fireEvent.click(view.getByRole('button',{name:'位置とサイズ'}));
  expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  finish(true);await waitFor(()=>expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false'));
  fireEvent.click(view.getByRole('button'));expect((view.getByLabelText('draft') as HTMLInputElement).value).toBe('125');
});
it('does not hide a rejected draft',async()=>{
  const close=vi.fn(async()=>false);
  const view=render(<NativeInspectorSection label="カラー" setting="color" beforeClose={close}><input aria-label="draft"/></NativeInspectorSection>);
  fireEvent.click(view.getByRole('button'));await waitFor(()=>expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
  expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true');
});
it('畳んでいる間だけ要約を見出しに出し、開閉は親が持てる（F14）',()=>{
  const onOpenChange=vi.fn();
  const view=render(<NativeInspectorSection label="配置" setting="place" summary="中央下 · 120%" open={false} onOpenChange={onOpenChange} beforeClose={async()=>true}><input aria-label="x"/></NativeInspectorSection>);
  expect(view.getByRole('button').textContent).toContain('中央下 · 120%');
  fireEvent.click(view.getByRole('button'));
  expect(onOpenChange).toHaveBeenCalledWith(true);
  const opened=render(<NativeInspectorSection label="配置" setting="place" summary="中央下 · 120%" open={true} onOpenChange={vi.fn()} beforeClose={async()=>true}><input aria-label="y"/></NativeInspectorSection>);
  expect(opened.getByRole('button',{name:'配置'}).textContent).not.toContain('中央下');
});

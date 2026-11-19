/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FeedbackCard } from './FeedbackCard';

afterEach(cleanup);
it('shows and sends only the edited preview after explicit actions', async()=>{
  const openExternal = vi.fn(), copy = vi.fn(async () => {}), onClose = vi.fn();
  const view=render(<FeedbackCard draft="画面：編集" email="owner@example.test" githubRepo="example/project" {...{openExternal,copy,onClose}}/>);
  expect(view.getByLabelText('送られる内容')).toHaveProperty('value','画面：編集');
  fireEvent.change(view.getByLabelText('何が起きましたか（任意）'),{target:{value:'止まりました'}});
  expect(view.getByLabelText('送られる内容')).toHaveProperty('value','止まりました\n\n画面：編集');
  fireEvent.change(view.getByLabelText('送られる内容'),{target:{value:'自分で確認して書いた本文 & #'}});
  expect(openExternal).not.toHaveBeenCalled();
  expect(copy).not.toHaveBeenCalled();
  for (const label of ['メールで送る','GitHub で報告する']) {
    fireEvent.click(view.getByRole('button',{name:label}));
    expect(new URL(openExternal.mock.calls.at(-1)![0]).searchParams.get('body')).toBe('自分で確認して書いた本文 & #');
  }
  fireEvent.click(view.getByRole('button',{name:'内容をコピー'}));
  expect(await view.findByRole('status')).toBeTruthy();
  expect(copy).toHaveBeenCalledWith('自分で確認して書いた本文 & #');
  fireEvent.click(document.body);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button',{name:'ご意見ボックスを閉じる'}));
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps copy available while configured destinations are empty',()=>{
  const view=render(<FeedbackCard draft="下書き" email="" githubRepo="" onClose={()=>{}}/>);
  expect(view.queryByRole('button',{name:'メールで送る'})).toBeNull();
  expect(view.queryByRole('button',{name:'GitHub で報告する'})).toBeNull();
  expect(view.getByRole('button',{name:'内容をコピー'})).toBeTruthy();
});

it('offers mail to the configured address by default and hides the unconfigured GitHub report',()=>{
  const openExternal = vi.fn();
  const view=render(<FeedbackCard draft="下書き" onClose={()=>{}} openExternal={openExternal}/>);
  fireEvent.click(view.getByRole('button',{name:'メールで送る'}));
  expect(new URL(openExternal.mock.calls.at(-1)![0]).pathname).toBe('feedback@video-harness.app');
  expect(view.queryByRole('button',{name:'GitHub で報告する'})).toBeNull();
});

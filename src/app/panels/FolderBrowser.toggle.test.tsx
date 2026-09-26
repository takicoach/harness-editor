/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {FolderBrowser} from './FolderBrowser';

afterEach(cleanup);
const props={open:true,projects:[],activeId:null,error:null,onPick:vi.fn()};

it('onToggle を渡さなければ畳むボタンを描かない',()=>{
  const view=render(<FolderBrowser {...props}/>);
  expect(view.queryByTitle('サイドバーを畳む')).toBeNull();
});
it('onToggle を渡せば今までどおり畳むボタンを描く',()=>{
  const view=render(<FolderBrowser {...props} onToggle={vi.fn()}/>);
  expect(view.getByTitle('サイドバーを畳む')).toBeTruthy();
});
it('閉じた表示でも onToggle が無ければ開くボタンを描かない',()=>{
  const view=render(<FolderBrowser {...props} open={false}/>);
  expect(view.queryByTitle('フォルダを開く')).toBeNull();
});

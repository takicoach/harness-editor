/** @vitest-environment jsdom */
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeColumnRail} from './NativeColumnRail';
afterEach(cleanup);
const LEFT=[{value:'projects',label:'プロジェクト',icon:'folder'},{value:'materials',label:'素材',icon:'film'}] as const;

it('左の帯は「左パネルを開く」ボタンとタブごとのアイコンボタンを持ち、縦組みの文字を出さない（R2-F2 A）',()=>{
  const view=render(<NativeColumnRail side="left" items={LEFT} onExpand={vi.fn()}/>);
  expect(view.getByRole('button',{name:'左パネルを開く'})).toBeTruthy();
  expect(view.getByRole('button',{name:'プロジェクトを開く'})).toBeTruthy();
  expect(view.getByRole('button',{name:'素材を開く'})).toBeTruthy();
  expect(view.container.querySelector('.native-column-rail-label')).toBeNull();
  expect(view.container.firstElementChild!.className).toContain('native-column-rail');
});
it('名前は data-tip（吹き出し）で持ち、右の帯は左向きに出す',()=>{
  const view=render(<NativeColumnRail side="right" items={[{value:'properties',label:'調整',icon:'sliders'}]} onExpand={vi.fn()}/>);
  expect(view.getByRole('button',{name:'右パネルを開く'}).getAttribute('data-tip')).toBe('右パネルを開く');
  expect(view.getByRole('button',{name:'調整を開く'}).getAttribute('data-tip-side')).toBe('left');
  expect(view.getByRole('button',{name:'調整を開く'}).getAttribute('title')).toBeNull();
});
it('開くボタンは値なし、アイコンボタンはタブの値で展開を通知する',()=>{
  const onExpand=vi.fn();
  const view=render(<NativeColumnRail side="left" items={LEFT} onExpand={onExpand}/>);
  fireEvent.click(view.getByRole('button',{name:'左パネルを開く'}));
  expect(onExpand).toHaveBeenLastCalledWith();
  fireEvent.click(view.getByRole('button',{name:'素材を開く'}));
  expect(onExpand).toHaveBeenLastCalledWith('materials');
});

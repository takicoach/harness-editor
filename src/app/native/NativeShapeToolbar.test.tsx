/** @vitest-environment jsdom */
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {NativeShapeToolbar,SHAPE_TOOLS} from './NativeShapeToolbar';
afterEach(cleanup);

it('6 種を並べ、選択中は aria-pressed が立つ',()=>{
  const view=render(<NativeShapeToolbar active="triangle" disabled={false} onPick={vi.fn()} onPlaceDefault={vi.fn()}/>);
  expect(SHAPE_TOOLS.map(t=>t.label)).toEqual(['矢印','直線','四角','楕円','三角','分度器']);
  expect(view.getByRole('button',{name:'三角'}).getAttribute('aria-pressed')).toBe('true');
  expect(view.getByRole('group',{name:'図形を描く'})).toBeTruthy();
});

it('同じ種類をもう一度押すと解除（null）を通知する',()=>{
  const onPick=vi.fn();
  const view=render(<NativeShapeToolbar active="rect" disabled={false} onPick={onPick} onPlaceDefault={vi.fn()}/>);
  fireEvent.click(view.getByRole('button',{name:'四角'}));
  expect(onPick).toHaveBeenCalledWith(null);
});

it('別の種類を押すとその種類を通知する',()=>{
  const onPick=vi.fn();
  const view=render(<NativeShapeToolbar active="rect" disabled={false} onPick={onPick} onPlaceDefault={vi.fn()}/>);
  fireEvent.click(view.getByRole('button',{name:'分度器'}));
  expect(onPick).toHaveBeenCalledWith('angle');
});

it('未選択なら「既定サイズで置く」は出ない',()=>{
  const view=render(<NativeShapeToolbar active={null} disabled={false} onPick={vi.fn()} onPlaceDefault={vi.fn()}/>);
  expect(view.queryByRole('button',{name:'既定サイズで置く'})).toBeNull();
});

it('「既定サイズで置く」は図形を選んだ時だけ出る（F17）',()=>{
  const none=render(<NativeShapeToolbar active={null} disabled={false} onPick={vi.fn()} onPlaceDefault={vi.fn()}/>);
  expect(none.queryByRole('button',{name:'既定サイズで置く'})).toBeNull();
  cleanup();
  const rect=render(<NativeShapeToolbar active="rect" disabled={false} onPick={vi.fn()} onPlaceDefault={vi.fn()}/>);
  expect(rect.getByRole('button',{name:'既定サイズで置く'})).toBeTruthy();
});

it('disabled なら全部押せない',()=>{
  const view=render(<NativeShapeToolbar active="rect" disabled onPick={vi.fn()} onPlaceDefault={vi.fn()}/>);
  for(const button of view.getAllByRole('button'))expect((button as HTMLButtonElement).disabled).toBe(true);
});

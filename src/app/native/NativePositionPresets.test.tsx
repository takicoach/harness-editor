/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NativePositionPresets} from './NativePositionPresets';

afterEach(cleanup);
it('renders nine buttons with readable names',()=>{
  const view=render(<NativePositionPresets preset="caption" disabled={false} current={null} onPick={vi.fn()}/>);
  expect(view.getAllByRole('button')).toHaveLength(9);
  expect(view.getByRole('button',{name:'中央に配置'})).toBeTruthy();
});
it('reports the normalised position of the cell that was pressed',()=>{
  const onPick=vi.fn();
  const view=render(<NativePositionPresets preset="caption" disabled={false} current={null} onPick={onPick}/>);
  fireEvent.click(view.getByRole('button',{name:'右下に配置'}));
  expect(onPick).toHaveBeenCalledWith({x:1,y:0});
});
it('marks the cell that matches the current position',()=>{
  const view=render(<NativePositionPresets preset="caption" disabled={false} current={{x:0,y:-0.5}} onPick={vi.fn()}/>);
  expect(view.getByRole('button',{name:'中央に配置'}).getAttribute('aria-pressed')).toBe('true');
  expect(view.getByRole('button',{name:'左上に配置'}).getAttribute('aria-pressed')).toBe('false');
});
it('disables the whole grid at once',()=>{
  const view=render(<NativePositionPresets preset="caption" disabled current={null} onPick={vi.fn()}/>);
  expect(view.getAllByRole('button').every(node=>(node as HTMLButtonElement).disabled)).toBe(true);
});
it('caption では中段中央が字幕の座標（y=-0.5）になる',()=>{
  const onPick=vi.fn();
  const view=render(<NativePositionPresets preset="caption" current={null} onPick={onPick}/>);
  fireEvent.click(view.getByRole('button',{name:'中央に配置'}));
  expect(onPick).toHaveBeenCalledWith({x:0,y:-0.5});
});
it('layer では下段中央が三分割の座標（y=1/3）になる',()=>{
  const onPick=vi.fn();
  const view=render(<NativePositionPresets preset="layer" current={null} onPick={onPick}/>);
  fireEvent.click(view.getByRole('button',{name:'中央下に配置'}));
  expect(onPick).toHaveBeenCalledWith({x:0,y:1/3});
});
it('押された状態の判定は preset ごとの座標で行う',()=>{
  const layer=render(<NativePositionPresets preset="layer" current={{x:0,y:1/3}} onPick={vi.fn()}/>);
  expect(layer.getByRole('button',{name:'中央下に配置'}).getAttribute('aria-pressed')).toBe('true');
  cleanup();
  const caption=render(<NativePositionPresets preset="caption" current={{x:0,y:1/3}} onPick={vi.fn()}/>);
  expect(caption.getAllByRole('button').every(node=>node.getAttribute('aria-pressed')==='false')).toBe(true);
});

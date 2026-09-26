/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import {NativeAddBar} from './NativeAddBar';

afterEach(cleanup);
const props=()=>({disabled:false,onAddText:vi.fn(),onAddTitle:vi.fn(),onPickShape:vi.fn(),onGoMaterials:vi.fn()});

it('6 つのボタンを「追加」の道具バーに並べ、既存のアクセシブル名を保つ',()=>{
  const view=render(<NativeAddBar {...props()}/>);
  const bar=view.getByRole('toolbar',{name:'追加'});
  expect(bar).toBeTruthy();
  for(const name of ['T テキスト','タイトル','図形'])expect(view.getByRole('button',{name})).toBeTruthy();
  expect(view.getByRole('button',{name:'＋ 画像'})).toBeTruthy();
  expect(view.getByRole('button',{name:'＋ BGM'})).toBeTruthy();
  expect(view.getByRole('button',{name:'＋ 効果音'})).toBeTruthy();
});
it('テロップとタイトルはそれぞれ 1 回だけ通知する',()=>{
  const p=props(),view=render(<NativeAddBar {...p}/>);
  fireEvent.click(view.getByRole('button',{name:'T テキスト'}));
  fireEvent.click(view.getByRole('button',{name:'タイトル'}));
  expect(p.onAddText).toHaveBeenCalledTimes(1);expect(p.onAddTitle).toHaveBeenCalledTimes(1);
});
it('図形は 1 つのメニューで、6 種を menuitem として出す',()=>{
  const p=props(),view=render(<NativeAddBar {...p}/>);
  const trigger=view.getByRole('button',{name:'図形'});
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(view.getAllByRole('menuitem').map(node=>node.textContent)).toEqual(['矢印','直線','四角','楕円','三角','分度器']);
  fireEvent.click(view.getByRole('menuitem',{name:'四角'}));
  expect(p.onPickShape).toHaveBeenCalledWith('rect');
  expect(view.queryAllByRole('menuitem')).toHaveLength(0);
});
it('図形メニューは ↑↓ で移動し、Esc で閉じてボタンへ戻る',()=>{
  const view=render(<NativeAddBar {...props()}/>);
  const trigger=view.getByRole('button',{name:'図形'});
  fireEvent.click(trigger);
  const items=view.getAllByRole('menuitem');
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(items[0]!,{key:'ArrowDown'});
  expect(document.activeElement).toBe(items[1]);
  fireEvent.keyDown(items[1]!,{key:'ArrowUp'});
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(items[0]!,{key:'Escape'});
  expect(view.queryAllByRole('menuitem')).toHaveLength(0);
  expect(document.activeElement).toBe(trigger);
});
it('図形メニューはメニュー外の pointerdown で閉じる',()=>{
  const view=render(<NativeAddBar {...props()}/>);
  const trigger=view.getByRole('button',{name:'図形'});
  fireEvent.click(trigger);
  expect(view.getAllByRole('menuitem')).toHaveLength(6);
  fireEvent.pointerDown(document.body);
  expect(view.queryAllByRole('menuitem')).toHaveLength(0);
});
it('図形メニューが開いている間だけ aria-controls がメニューの id を指す',()=>{
  const view=render(<NativeAddBar {...props()}/>);
  const trigger=view.getByRole('button',{name:'図形'});
  expect(trigger.getAttribute('aria-controls')).toBeNull();
  fireEvent.click(trigger);
  const menu=view.getByRole('menu',{name:'図形の種類'});
  expect(trigger.getAttribute('aria-controls')).toBe(menu.getAttribute('id'));
});
it('素材系は該当タブを通知するだけ（文書を変える経路を持たない）',()=>{
  const p=props(),view=render(<NativeAddBar {...p}/>);
  fireEvent.click(view.getByRole('button',{name:'＋ 画像'}));
  fireEvent.click(view.getByRole('button',{name:'＋ BGM'}));
  fireEvent.click(view.getByRole('button',{name:'＋ 効果音'}));
  expect(p.onGoMaterials.mock.calls.map(call=>call[0])).toEqual(['image','bgm','se']);
});
it('busy の間は 6 つとも押せない',()=>{
  const view=render(<NativeAddBar {...props()} disabled/>);
  expect(view.getAllByRole('button').every(node=>(node as HTMLButtonElement).disabled)).toBe(true);
});

const workspace=readFileSync('src/app/native/NativeWorkspace.tsx','utf8');
it('素材パネルの「作る」列を撤去する',()=>{
  expect(workspace).not.toContain('native-library-make');
  expect(workspace).not.toContain('>作る<');
});
it('トラック側は ＋ 映像トラック・＋ 音声トラックの 2 つだけ',()=>{
  expect(workspace).toContain('＋ 映像トラック');
  expect(workspace).toContain('＋ 音声トラック');
  expect(workspace).not.toMatch(/native-timeline-options[\s\S]{0,600}<Icon name="plus" \/>字幕/);
  expect(workspace).not.toMatch(/native-timeline-options[\s\S]{0,600}<Icon name="plus" \/>BGM/);
});
it('仕上げのヒントは上段の名前に合わせる',()=>{
  expect(workspace).toContain('「＋ BGM」から追加してください。');
  expect(workspace).toContain('「＋ テロップ」から追加してください。');
});

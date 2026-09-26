/** @vitest-environment jsdom */
// src/app/native/NativeSegmented.test.tsx
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeSegmented } from './NativeSegmented';

// jsdom は寸法を持たない。ボタン幅 80px・間隔 2px の並びを offsetLeft / offsetWidth で模擬する。
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 80; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { const parent = (this as HTMLElement).parentElement; return parent ? Array.prototype.indexOf.call(parent.children, this) * 82 : 0; } });
  // 1 行に収まる並び: ボタン高 80・コンテナ高 80・offsetTop 0 → 指示器の Y ずれは 0。
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 80; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 80; } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const items = [{ value: 'review', label: '確認' }, { value: 'edit', label: '編集' }, { value: 'finish', label: '仕上げ' }] as const;

it('tablist は aria-selected と aria-controls を持ち、選択中だけ Tab 停止点になる', () => {
  const view = render(<NativeSegmented role="tablist" label="左パネル" items={[{ value: 'projects', label: 'プロジェクト', controls: 'panel-projects' }, { value: 'materials', label: '素材', controls: 'panel-materials' }]} value="materials" onChange={() => {}} />);
  const tab = view.getByRole('tab', { name: '素材' });
  expect(tab.getAttribute('aria-selected')).toBe('true');
  expect(tab.getAttribute('aria-controls')).toBe('panel-materials');
  expect(tab.tabIndex).toBe(0);
  expect(view.getByRole('tab', { name: 'プロジェクト' }).tabIndex).toBe(-1);
});

it('group（ナビ）は素のボタンに aria-current=page を付ける', () => {
  const view = render(<NativeSegmented role="group" label="モード" items={items} value="edit" onChange={() => {}} />);
  expect(view.getByRole('button', { name: '編集' }).getAttribute('aria-current')).toBe('page');
  expect(view.getByRole('button', { name: '確認' }).getAttribute('aria-current')).toBeNull();
});

it('指示器は選択中ボタンの位置へ transform で動き、幅は即時に合わせる', () => {
  const onChange = vi.fn();
  const view = render(<NativeSegmented role="group" label="モード" items={items} value="review" onChange={onChange} />);
  const indicator = () => view.container.querySelector<HTMLElement>('.native-seg-indicator')!;
  expect(indicator().style.transform).toBe('translate(0px, 0px)');
  expect(indicator().style.width).toBe('80px');
  fireEvent.click(view.getByRole('button', { name: '仕上げ' }));
  expect(onChange).toHaveBeenCalledWith('finish');
  view.rerender(<NativeSegmented role="group" label="モード" items={items} value="finish" onChange={onChange} />);
  expect(indicator().style.transform).toBe('translate(164px, 0px)');
});

it('←→ と Home / End で選択が移り、イベントはワークスペースへ伝えない', () => {
  const onChange = vi.fn(), outer = vi.fn();
  window.addEventListener('keydown', outer);
  const view = render(<NativeSegmented role="radiogroup" label="工具" items={[{ value: 'select', label: '選択', key: 'V' }, { value: 'razor', label: '分割', key: 'C' }, { value: 'range', label: 'なぞってカット', key: 'B' }]} value="select" onChange={onChange} />);
  const first = view.getByRole('radio', { name: '選択' });   // M-5: キー文字はアクセシブル名に含めない
  expect(first.getAttribute('aria-checked')).toBe('true');
  expect(first.getAttribute('aria-keyshortcuts')).toBe('V');
  const kbd = view.container.querySelector('.native-key')!;
  expect(kbd.textContent).toBe('V'); expect(kbd.getAttribute('aria-hidden')).toBe('true');
  fireEvent.keyDown(first, { key: 'ArrowRight' }); expect(onChange).toHaveBeenLastCalledWith('razor');
  fireEvent.keyDown(first, { key: 'End' }); expect(onChange).toHaveBeenLastCalledWith('range');
  fireEvent.keyDown(first, { key: 'ArrowLeft' }); expect(onChange).toHaveBeenLastCalledWith('range');
  expect(outer).not.toHaveBeenCalled();
  fireEvent.click(first); expect(onChange).toHaveBeenCalledTimes(3);
  window.removeEventListener('keydown', outer);
});

it('group（ナビ）は roving tabindex にせず、全ボタンが通常の Tab 停止点になる', () => {
  const view = render(<NativeSegmented role="group" label="モード" items={items} value="edit" onChange={() => {}} />);
  expect(view.getByRole('button', { name: '確認' }).tabIndex).toBe(0);
  expect(view.getByRole('button', { name: '編集' }).tabIndex).toBe(0);
  expect(view.getByRole('button', { name: '仕上げ' }).tabIndex).toBe(0);
});

it('同じ value なら親が再レンダーしても ResizeObserver を作り直さない', () => {
  // I-2: 呼び出し側が items をインライン配列リテラルで渡す（＝毎レンダー新しい参照）状況でも、
  // 再生中の毎フレーム再レンダーで observer の teardown/setup と強制リフローが走らないこと。
  const observe = vi.fn(), disconnect = vi.fn(), created = vi.fn();
  class FakeResizeObserver {
    constructor(_callback: ResizeObserverCallback) { created(); }
    observe = observe;
    unobserve = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const props = () => ({ role: 'group' as const, label: 'モード', value: 'edit' as const, onChange: () => {} });
  const view = render(<NativeSegmented {...props()} items={[{ value: 'review', label: '確認' }, { value: 'edit', label: '編集' }, { value: 'finish', label: '仕上げ' }]} />);
  expect(created).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i += 1)
    view.rerender(<NativeSegmented {...props()} items={[{ value: 'review', label: '確認' }, { value: 'edit', label: '編集' }, { value: 'finish', label: '仕上げ' }]} />);
  expect(created).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
  expect(disconnect).not.toHaveBeenCalled();
});

it('value=null ではどのボタンも選択状態にせず、停止点を先頭に置く',()=>{
  const view=render(<NativeSegmented role="tablist" label="右パネル" items={[{value:'a',label:'A'},{value:'b',label:'B'}]} value={null} onChange={()=>{}}/>);
  expect(view.getAllByRole('tab').every(node=>node.getAttribute('aria-selected')==='false')).toBe(true);
  expect(view.getByRole('tab',{name:'A'}).tabIndex).toBe(0);
  expect(view.getByRole('tab',{name:'B'}).tabIndex).toBe(-1);
  expect((view.container.querySelector('.native-seg-indicator') as HTMLElement).style.width).toBe('0px');
});

it('value=null からの矢印は端から動き出す（ArrowLeft が末尾の 1 つ手前へ飛ばない。Task 8 Minor）',()=>{
  const items=[{value:'a',label:'A'},{value:'b',label:'B'},{value:'c',label:'C'}];
  const right=vi.fn(),left=vi.fn();
  const rightView=render(<NativeSegmented role="tablist" label="右パネル" items={items} value={null} onChange={right}/>);
  fireEvent.keyDown(rightView.getByRole('tab',{name:'A'}),{key:'ArrowRight'});
  expect(right).toHaveBeenCalledWith('a');            // 停止点の先頭から 1 つ目へ
  cleanup();
  const leftView=render(<NativeSegmented role="tablist" label="右パネル" items={items} value={null} onChange={left}/>);
  fireEvent.keyDown(leftView.getByRole('tab',{name:'A'}),{key:'ArrowLeft'});
  expect(left).toHaveBeenCalledWith('c');             // 末尾へ回り込む（'b' ではない）
});

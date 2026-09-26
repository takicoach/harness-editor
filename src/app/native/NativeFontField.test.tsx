/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NativeFontField} from './NativeFontField';
import {FONTS,fontStack} from '../../core/fonts';

afterEach(cleanup);
it('offers every declared font, grouped by bundled and system, without hard-coding a count',()=>{
  const view=render(<NativeFontField value={FONTS[0]!.family} disabled={false} onCommit={vi.fn()}/>);
  const select=view.getByLabelText('フォント') as HTMLSelectElement;
  expect(select.querySelectorAll('option')).toHaveLength(FONTS.length);
  expect([...select.querySelectorAll('optgroup')].map(node=>node.getAttribute('label'))).toEqual(['同梱フォント','システム']);
});
it('commits the family string, not the id',()=>{
  const onCommit=vi.fn();
  const target=FONTS.find(font=>font.group==='system')!;
  const view=render(<NativeFontField value={FONTS[0]!.family} disabled={false} onCommit={onCommit}/>);
  fireEvent.change(view.getByLabelText('フォント'),{target:{value:target.family}});
  expect(onCommit).toHaveBeenCalledWith(target.family);
});
it('keeps an unknown family selectable so an old project never loses its setting',()=>{
  const view=render(<NativeFontField value={'"Legacy Face", serif'} disabled={false} onCommit={vi.fn()}/>);
  const select=view.getByLabelText('フォント') as HTMLSelectElement;
  expect(select.value).toBe('"Legacy Face", serif');
  expect(view.getByText('この案件の設定（一覧にありません）')).toBeTruthy();
});
it('selects the matching font when value is a fallback stack, not just a raw family',()=>{
  const font=FONTS.find(f=>f.id==='noto-serif-jp')!;
  const view=render(<NativeFontField value={fontStack(font)} disabled={false} onCommit={vi.fn()}/>);
  const select=view.getByLabelText('フォント') as HTMLSelectElement;
  expect(select.value).toBe(font.family);
  expect(view.queryByText('この案件の設定（一覧にありません）')).toBeNull();
});
it('commits the plain family of the newly chosen option, even when the current value was a stack',()=>{
  const onCommit=vi.fn();
  const current=FONTS.find(f=>f.id==='noto-serif-jp')!;
  const target=FONTS.find(f=>f.group==='system')!;
  const view=render(<NativeFontField value={fontStack(current)} disabled={false} onCommit={onCommit}/>);
  fireEvent.change(view.getByLabelText('フォント'),{target:{value:target.family}});
  expect(onCommit).toHaveBeenCalledWith(target.family);
});
it('previews each option in its own face',()=>{
  const view=render(<NativeFontField value={FONTS[0]!.family} disabled={false} onCommit={vi.fn()}/>);
  const option=view.getByRole('option',{name:FONTS[0]!.label}) as HTMLOptionElement;
  // jsdom の CSSOM は空白を含む font-family を引用符付きで直列化する（ブラウザの
  // getComputedStyle と同じ挙動）。比較したいのは引用符の有無ではなく書体そのもの。
  expect(option.style.fontFamily.replace(/^"|"$/g,'')).toBe(FONTS[0]!.family);
});

/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import {NativeSpeedScale} from './NativeSpeedScale';
import {SPEED_PRESETS,formatRate,rateToSlider} from './speedScale';

afterEach(cleanup);
it('offers every preset as a one-click button and marks the active one',()=>{
  const onPick=vi.fn();
  const view=render(<NativeSpeedScale rate={2} disabled={false} scope="全体" onPick={onPick}/>);
  const buttons=SPEED_PRESETS.map(value=>view.getByRole('button',{name:formatRate(value)}));
  expect(buttons).toHaveLength(SPEED_PRESETS.length);
  expect(view.getByRole('button',{name:formatRate(2)}).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(view.getByRole('button',{name:formatRate(0.5)}));
  expect(onPick).toHaveBeenCalledWith(0.5);
});
it('drives the same value through a logarithmic slider',()=>{
  const onPick=vi.fn();
  const view=render(<NativeSpeedScale rate={1} disabled={false} scope="全体" onPick={onPick}/>);
  const slider=view.getByLabelText('全体の速度スライダー') as HTMLInputElement;
  expect(Number(slider.value)).toBe(rateToSlider(1));
  fireEvent.change(slider,{target:{value:String(rateToSlider(4))}});
  expect(onPick.mock.calls[0]![0]).toBeCloseTo(4,6);
});
it('disables every control at once',()=>{
  const view=render(<NativeSpeedScale rate={1} disabled scope="全体" onPick={vi.fn()}/>);
  expect((view.getByLabelText('全体の速度スライダー') as HTMLInputElement).disabled).toBe(true);
  expect((view.getByRole('button',{name:formatRate(1)}) as HTMLButtonElement).disabled).toBe(true);
});
it('scopes labels per panel so a global and a clip panel drawn together do not collide',()=>{
  const view=render(<>
    <NativeSpeedScale rate={1} scope="全体" onPick={vi.fn()}/>
    <NativeSpeedScale rate={1} scope="このクリップ" onPick={vi.fn()}/>
  </>);
  expect(view.getByLabelText('全体の速度スライダー')).toBeTruthy();
  expect(view.getByLabelText('このクリップの速度スライダー')).toBeTruthy();
  expect(view.getByRole('group',{name:'全体のよく使う倍率'})).toBeTruthy();
  expect(view.getByRole('group',{name:'このクリップのよく使う倍率'})).toBeTruthy();
});

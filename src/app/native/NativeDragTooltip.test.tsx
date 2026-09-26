/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {NativeDragTooltip,dragTooltipText} from './NativeDragTooltip';

afterEach(cleanup);
it('shows the absolute clock and a signed move amount in frames and seconds',()=>{
  expect(dragTooltipText(150,120,30)).toEqual({clock:'0:05.00',delta:'+30f（+1.00秒）'});
  expect(dragTooltipText(90,120,30)).toEqual({clock:'0:03.00',delta:'−30f（−1.00秒）'});
  expect(dragTooltipText(120,120,30)).toEqual({clock:'0:04.00',delta:'0f（0.00秒）'});
});
it('never divides by a zero frame rate',()=>{
  expect(dragTooltipText(150,120,0)).toEqual({clock:'0:00.00',delta:'+30f（0.00秒）'});
});
it('renders at the pixel position it is given',()=>{
  const view=render(<NativeDragTooltip frame={150} originFrame={120} fps={30} left={420} top={64}/>);
  const node=view.container.querySelector<HTMLElement>('.native-drag-tooltip')!;
  expect([node.style.left,node.style.top]).toEqual(['420px','64px']);
  expect(node.textContent).toContain('+30f');
});

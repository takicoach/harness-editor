/** @vitest-environment jsdom */
import {afterEach,it,expect} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {TaskProgress} from './TaskProgress';
afterEach(cleanup);
it('announces a measured percentage and leaves unmeasured phases indeterminate',()=>{
  const view=render(<TaskProgress label="転送" value={.42}/>);
  expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
  view.rerender(<TaskProgress label="解析中"/>);expect(view.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);
});

/** @vitest-environment jsdom */
// src/app/Icon.test.tsx
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Icon, type IconName } from './Icon';

afterEach(cleanup);

const ADDED: IconName[] = ['play','pause','skip-back','skip-forward','step-back','step-forward','rewind','fast-forward','eye','eye-off','scissors','cursor','magnet','pen','check','x','volume','mute','sparkles','panel-left','panel-right','layout-wide','type','image','shapes','film','sliders','question','arrow-up','arrow-down','export','grip','layout-tall'];

it('追加したアイコンはすべて path を持つ', () => {
  for (const name of ADDED) {
    const view = render(<Icon name={name} />);
    const d = view.container.querySelector('path')?.getAttribute('d') ?? '';
    expect(d.length, name).toBeGreaterThan(8);
    view.unmount();
  }
});

it('filled は塗りつぶし（再生・一時停止の三角と二本線に使う）', () => {
  const view = render(<Icon name="play" filled />);
  const svg = view.container.querySelector('svg')!;
  expect(svg.getAttribute('fill')).toBe('currentColor');
  expect(svg.getAttribute('stroke')).toBe('none');
});

it('既定は線画（stroke 1.8・fill none）', () => {
  const view = render(<Icon name="eye" />);
  const svg = view.container.querySelector('svg')!;
  expect(svg.getAttribute('fill')).toBe('none');
  expect(svg.getAttribute('stroke-width')).toBe('1.8');
});

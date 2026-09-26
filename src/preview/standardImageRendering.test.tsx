// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InsertImage } from '../../project-template/src/InsertImage/InsertImage';
import { CaptureFrameProvider, setStaticFileResolver } from '../captureRuntime';
import { createAssetResolver } from '../capturePage/staticFileResolver';

beforeEach(() => setStaticFileResolver(createAssetResolver('standard-image-test')));
afterEach(() => setStaticFileResolver(null));

function inspect(frame: number, type: string, extra: Record<string, unknown> = {}) {
  const segment = { id: 1, startFrame: 150, endFrame: 300, file: 'overlay.png', type, ...extra };
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(<CaptureFrameProvider frame={frame}
    videoConfig={{width:1920,height:1080,fps:30,durationInFrames:segment.endFrame-segment.startFrame}}>
    <InsertImage segment={segment as React.ComponentProps<typeof InsertImage>['segment']} />
  </CaptureFrameProvider>);
  const img = root.querySelector('img')!;
  let opacity = 1;
  const transforms: string[] = [];
  for (let el: HTMLElement | null = img; el && el !== root; el = el.parentElement) {
    opacity *= el.style.opacity === '' ? 1 : Number(el.style.opacity);
    if (el.style.transform) transforms.push(el.style.transform);
  }
  return { img, root, opacity, transforms };
}

describe('standard image rendering contract', () => {
  it('positions plain images directly without a fractional centering transform', () => {
    const sample = inspect(75, 'plain', { position: { x: .8125, y: -.5972222222 }, scale: .125, rotation: 12 });
    const box = sample.img.parentElement!;
    expect(Number.parseFloat(box.style.left)).toBeCloseTo(84.375);
    expect(Number.parseFloat(box.style.top)).toBeCloseTo(13.88888889);
    expect(box.style.width).toBe('12.5%');
    expect(box.style.height).toBe('12.5%');
    expect(box.style.transform).toBe('rotate(12deg)');
    expect(box.style.transformOrigin).toBe('50% 50%');
  });
  it('keeps a plain image visible and unchanged from first through last frame', () => {
    const samples = [0, 75, 149].map(f => inspect(f, 'plain', {
      position: { x: .8125, y: -.5972222222 }, scale: .125, opacity: .8,
    }));
    for (const sample of samples) {
      expect(sample.opacity).toBe(.8);
      expect(sample.img.style.objectFit).toBe('contain');
      expect(sample.img.style.width).toBe('100%');
      expect(sample.img.style.height).toBe('100%');
      expect(sample.img.style.border).toBe('');
      expect(sample.img.style.boxShadow).toBe('');
      expect(sample.transforms).toEqual(samples[0]!.transforms);
    }
  });
  it('can display a one-frame plain image without a hidden first frame', () => {
    expect(inspect(0, 'plain', { endFrame: 151 }).opacity).toBe(1);
  });
  it('honors explicitly disabled entrance and exit on the existing photo mode', () => {
    const extra = { enter: { kind: 'none', frames: 8 }, exit: { kind: 'none', frames: 8 } };
    expect(inspect(0, 'photo', extra).opacity).toBe(1);
    expect(inspect(149, 'photo', extra).opacity).toBe(1);
  });
  it('applies an explicitly requested fade to plain images exactly once', () => {
    expect(inspect(4, 'plain', { enter: { kind: 'fade', frames: 8 } }).opacity).toBe(.5);
    expect(inspect(146, 'plain', { exit: { kind: 'fade', frames: 8 } }).opacity).toBe(.5);
  });
  it('preserves the old default photo fade and slow zoom', () => {
    expect(inspect(0, 'photo').opacity).toBe(0);
    const middle = inspect(75, 'photo');
    expect(middle.opacity).toBe(1);
    expect(middle.transforms).toContain('scale(1.025)');
    expect(middle.img.style.objectFit).toBe('cover');
  });
  it('keeps infographic decoration and overlay backdrop in existing modes', () => {
    expect(inspect(75, 'infographic').img.style.border).not.toBe('');
    expect(inspect(75, 'overlay').root.textContent).toBe('');
    expect(inspect(75, 'overlay').root.innerHTML).toContain('rgba(0, 0, 0, 0.7)');
  });
});

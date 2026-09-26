import { describe, expect, it } from 'vitest';
import { applyCube, parseCube, sampleCube } from './lut';

function cube(transform = (r: number, g: number, b: number) => [r, g, b]): string {
  const lines = ['TITLE "Test #1" # comment', 'LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(transform(r, g, b).join(' '));
  return lines.join('\n');
}
describe('3D cube LUT', () => {
  it('parses comments/title and red-fastest order, interpolating between eight samples', () => {
    const lut = parseCube(cube((r, g, b) => [b, r, g]));
    expect(lut.title).toBe('Test #1');
    sampleCube(lut, [.2, .4, .8]).forEach((v, i) => expect(v).toBeCloseTo([.8, .2, .4][i]!, 12));
  });
  it('zero intensity is identity even outside a non-default domain', () => {
    const lut = parseCube('DOMAIN_MIN .25 .25 .25\nDOMAIN_MAX .75 .75 .75\n' + cube());
    expect(applyCube(lut, [.1, .5, .9], 0)).toEqual([.1, .5, .9]);
    expect(applyCube(lut, [.1, .5, .9], .5)).toEqual([.05, .5, .95]);
    expect(applyCube(lut, [.1, .5, .9], 1)).toEqual([0, .5, 1]);
  });
  it('clamps after blending rather than clamping LUT samples or blending an identity LUT', () => {
    const lut = parseCube(cube(() => [-1, 2, .5]));
    expect(applyCube(lut, [.5, .5, .5], .5)).toEqual([0, 1, .5]);
  });
  it.each([
    'LUT_3D_SIZE 1', 'LUT_3D_SIZE 66', 'LUT_1D_SIZE 2', 'LUT_3D_SIZE 2\nNaN 0 0',
    'LUT_3D_SIZE 2\n1e100 0 0', 'LUT_3D_SIZE 2\n0 0 0',
  ])('rejects malformed/unsupported LUT %s', text => expect(() => parseCube(text)).toThrow());
  it('rejects excess points, reversed domains, duplicate headers and misplaced headers', () => {
    expect(() => parseCube(cube() + '\n0 0 0')).toThrow(/多い/);
    expect(() => parseCube('DOMAIN_MIN 1 1 1\n' + cube())).toThrow(/DOMAIN/);
    expect(() => parseCube('LUT_3D_SIZE 2\n' + cube())).toThrow(/重複/);
    expect(() => parseCube(cube() + '\nDOMAIN_MIN 0 0 0')).toThrow(/データ後/);
    expect(() => parseCube('DOMAIN_MIN .999999999 .999999999 .999999999\n' + cube())).toThrow(/32bit/);
    expect(() => parseCube('DOMAIN_MIN -3e38 -3e38 -3e38\nDOMAIN_MAX 3e38 3e38 3e38\n' + cube())).toThrow(/32bit/);
  });
});

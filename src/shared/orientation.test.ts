import { describe, it, expect } from 'vitest';
import { orientationCode } from './orientation';

describe('orientationCode', () => {
  it('landscape は h', () => { expect(orientationCode('landscape')).toBe('h'); });
  it('portrait は v', () => { expect(orientationCode('portrait')).toBe('v'); });
  it('square は sq', () => { expect(orientationCode('square')).toBe('sq'); });
});

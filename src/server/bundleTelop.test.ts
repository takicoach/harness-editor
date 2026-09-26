import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bundleNativeTelopComponent } from './bundleTelop';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');

describe('bundleNativeTelopComponent', () => {
  it('native swatches compile the real project component against our audited frame module', async () => {
    const js = await bundleNativeTelopComponent(SAMPLE, 'fixture');
    expect(js).toContain('@harness/frame-runtime');
    expect(js).not.toMatch(/from\s*["']remotion["']/);
    expect(js).toContain('#FFE57A');
    expect(js).toMatch(/from\s*["']react-dom["']/);
    expect(js).toMatch(/from\s*["']react\/jsx-runtime["']/);
    expect(js).not.toMatch(/from\s*["']\.\/telopStyles["']/);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRenderOutput } from './publishRenderOutput';

const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'render-publish-'));
  dirs.push(dir);
  return { dir, source: join(dir, '.render.mp4'), destination: join(dir, 'result.mp4') };
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('publish without replacing an existing video', () => {
  it('publishes the completed bytes and removes the temporary name', () => {
    const { source, destination } = setup();
    writeFileSync(source, 'completed render');
    publishRenderOutput(source, destination);
    expect(readFileSync(destination, 'utf8')).toBe('completed render');
    expect(existsSync(source)).toBe(false);
  });
  it('keeps an existing output and also refuses a dangling symlink', () => {
    const { source, destination } = setup();
    writeFileSync(source, 'new render');
    writeFileSync(destination, 'previous approved video');
    expect(() => publishRenderOutput(source, destination)).toThrow();
    expect(readFileSync(destination, 'utf8')).toBe('previous approved video');
    expect(readFileSync(source, 'utf8')).toBe('new render');
    unlinkSync(destination);
    symlinkSync('missing.mp4', destination);
    expect(() => publishRenderOutput(source, destination)).toThrow();
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
  });
});

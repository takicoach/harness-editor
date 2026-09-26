import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error The CLI audit shares this plain ESM implementation.
import { collectDefinedClasses } from './cssClassAudit.mjs';

const roots: string[] = [];
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'css-import-audit-'));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, source);
  }
  return join(root, 'main.tsx');
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('CSS audit follows the rendered application imports', () => {
  it('follows bare import URLs but excludes filenames in declaration URLs', () => {
    const entry = fixture({ 'main.tsx': "import './base.css';",
      'base.css': '@import url(./nested.css); .base { background: url(./asset.missing); }',
      'nested.css': '@media (width > 1px) { .nested { color: red; } }' });
    expect([...collectDefinedClasses(entry)].sort()).toEqual(['base', 'nested']);
  });
  it('excludes inline type-only dependency edges', () => {
    for (const source of ["import { type Props } from './Panel';", "export { type Props } from './Panel';"]) {
      const entry = fixture({ 'main.tsx': source,
        'Panel.tsx': "import './unused.css'; export interface Props {}",
        'unused.css': '.missing { color: red; }' });
      expect(collectDefinedClasses(entry).has('missing')).toBe(false);
    }
  });
  it('ignores CSS strings containing import examples or class-like text', () => {
    const entry = fixture({ 'main.tsx': "import './base.css';",
      'base.css': `.base::before { content: "@import './unused.css'; .pretend"; }`,
      'unused.css': '.missing { color: red; }' });
    expect([...collectDefinedClasses(entry)]).toEqual(['base']);
  });
  it('includes component CSS and nested CSS imports reached from the entry', () => {
    const entry = fixture({
      'main.tsx': "import './base.css'; import './Panel';",
      'Panel.tsx': "import './panel.css'; export const Panel = () => null;",
      'base.css': '.base { color: red; }',
      'panel.css': '@import "./nested.css"; .panel { color: blue; }',
      'nested.css': '.nested { display: flex; }',
    });
    const defined = collectDefinedClasses(entry) as Set<string>;
    expect([...defined].sort()).toEqual(['base', 'nested', 'panel']);
  });
  it('does not let unused or comment-only styles hide a missing class', () => {
    const entry = fixture({
      'main.tsx': "import './base.css'; // import './unused.css'\nconst example = \"import './unused.css'\";",
      'base.css': '.base { color: red; }',
      'unused.css': '.missing { color: red; }',
    });
    const defined = collectDefinedClasses(entry) as Set<string>;
    expect(defined.has('base')).toBe(true);
    expect(defined.has('missing')).toBe(false);
  });
  it('terminates import cycles while continuing to check real classes', () => {
    const entry = fixture({
      'main.tsx': "import './Panel';",
      'Panel.tsx': "import './main'; import './panel.css';",
      'panel.css': '@import "./other.css"; .panel { color: blue; }',
      'other.css': '@import "./panel.css"; .other { color: blue; }',
    });
    expect([...(collectDefinedClasses(entry) as Set<string>)].sort()).toEqual(['other', 'panel']);
  });
});

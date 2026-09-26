import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const native=readFileSync(join(__dirname,'native.css'),'utf8');

describe('data-tip 吹き出しはアクセシブル名を汚さない（alt-text 構文）',()=>{
  it('[data-tip]::after 規則が存在する',()=>{
    expect(native).toMatch(/\[data-tip\]::after\s*\{/);
  });
  it('content は attr(data-tip) / "" （alt-text 構文でアクセシビリティツリーから除外）',()=>{
    const rule=native.match(/\[data-tip\]::after\s*\{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).toContain('content:attr(data-tip) / ""');
    expect(rule![0]).not.toContain('content:attr(data-tip);');
  });
});

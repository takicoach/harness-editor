import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {headerCompact,HEADER_COMPACT_BELOW} from './headerLayout';

describe('headerCompact',()=>{
  it('1200px 未満で縮める',()=>{
    expect(HEADER_COMPACT_BELOW).toBe(1200);
    expect(headerCompact(1199)).toBe(true);
    expect(headerCompact(1200)).toBe(false);
    expect(headerCompact(2000)).toBe(false);
  });
  it('未計測（0・NaN・負）は縮めない',()=>{
    expect(headerCompact(0)).toBe(false);
    expect(headerCompact(NaN)).toBe(false);
    expect(headerCompact(-1)).toBe(false);
  });
});

describe('native のヘッダー高さ',()=>{
  const css=readFileSync(join(__dirname,'native.css'),'utf8');
  it('legacy の 96px に引きずられない（.native-workspace で --topbar-h を 52px に再宣言）',()=>{
    expect(css).toMatch(/\.native-workspace\s*\{[^}]*--topbar-h:\s*52px/);
  });
  it('保存状態を display:none で消さない（1200px 未満は点だけ残す）',()=>{
    expect(css).not.toMatch(/\.native-save-state\s*\{\s*display:\s*none/);
  });
  it('縮小時の規則がある',()=>{
    for(const rule of ['.native-header[data-compact] .native-brand','.native-header[data-compact] .native-ai-work-label','.native-header[data-compact] .native-auto-save .native-switch-label'])expect(css,rule).toContain(rule);
  });
});

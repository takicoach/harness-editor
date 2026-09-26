import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const workspace=readFileSync(join(__dirname,'NativeWorkspace.tsx'),'utf8');
const native=readFileSync(join(__dirname,'native.css'),'utf8');
const polish=readFileSync(join(__dirname,'native-polish.css'),'utf8');

describe('タイムラインのツールバー（F4 / R2-F4 A）',()=>{
  it('工具とトグルはアイコンだけで、名前とキーは吹き出し（data-tip）',()=>{
    for(const tip of ["tip: '選択 V'","tip: '分割 C'","tip: 'なぞってカット B'",'aria-label="スナップ" data-tip="スナップ S"','aria-label="詰める" data-tip="詰める R"'])expect(workspace,tip).toContain(tip);
    expect(workspace).toContain('className="native-sr-only">選択</span>');
    expect(workspace).not.toContain("title: '選択（V）'");
    expect(workspace).not.toMatch(/value: 'select'[^\n]*key: 'V'/);   // key を渡すと NativeSegmented が V を描く（アイコンだけの決定に反する）
  });
  it('折り返さない（wrap 禁止・font-size:0 のラベル消しを使わない）',()=>{
    expect(native).not.toMatch(/\.native-timeline-toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(polish).not.toMatch(/\.native-timeline-toolbar\{[^}]*flex-wrap:wrap/);
    expect(native).not.toMatch(/font-size:\s*0\b/);
    expect(native).not.toMatch(/\.native-save-state\s*\{\s*display:\s*none/);
  });
  it('幅が足りないときは表示群を NativeViewMenu に入れる（判定は幅の固定閾値ではなく溢れの実測）',()=>{
    expect(workspace).toContain('<NativeViewMenu>');
    expect(workspace).toContain('toolbarFit(');
    expect(workspace).toContain('scrollWidth: host.scrollWidth');
    expect(workspace).not.toContain('toolbarCompact(');
  });
  it('ボタンの文字は折り返さない（幅を決定的にして溢れを測れるようにする・I-7）',()=>{
    expect(polish).toContain('.native-timeline-toolbar button{white-space:nowrap}');
    expect(polish).not.toMatch(/\.native-timeline-toolbar button\{white-space:nowrap\s*!important/);
  });
});

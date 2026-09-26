import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const studio=readFileSync(join(__dirname,'native-studio.css'),'utf8');
const polish=readFileSync(join(__dirname,'native-polish.css'),'utf8');

describe('数値フィールド（F17）',()=>{
  it('ラベル 76 / スライダー 1fr / 数値 52 で、右カラム 280px 未満は 2 行',()=>{
    expect(studio).toMatch(/\.native-number-field\s*\{[^}]*grid-template-columns:\s*76px minmax\(0,1fr\) 52px/);
    expect(studio).toMatch(/@container\s*\(max-width:\s*280px\)/);
    expect(polish).toMatch(/\.native-inspector-host\{[^}]*container-type:inline-size/);
  });
  it('プロジェクト一覧のメタ行は 11.5px 以上',()=>{
    expect(studio).toMatch(/\.native-project-list \.fb-item-meta[^{]*\{[^}]*font-size:\s*var\(--native-font-sub\)/);
  });
});

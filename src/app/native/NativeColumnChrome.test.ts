import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';

const workspace=readFileSync('src/app/native/NativeWorkspace.tsx','utf8');

it('畳むボタンは文字の矢印を使わない',()=>{
  expect(workspace).not.toContain('>‹<');
  expect(workspace).not.toContain('>›<');
  expect(workspace).not.toContain('>▶<');
});
it('左は Icon＋「畳む」、右は Icon だけ（AI 帯の行に置く）。名前と aria-expanded は変えない',()=>{
  expect(workspace).toContain('aria-label="左パネルを畳む"');
  expect(workspace).toContain('aria-label="右パネルを畳む"');
  expect(workspace).toMatch(/native-column-collapse"[\s\S]*?aria-label="左パネルを畳む"[\s\S]*?>\s*<Icon name="chevron-left" strokeWidth=\{2\.75\} \/>畳む/);
  expect(workspace).toMatch(/native-column-collapse"[\s\S]*?aria-label="右パネルを畳む"[\s\S]*?>\s*<Icon name="chevron-right" strokeWidth=\{2\.75\} \/>\s*<\/button>/);
});
/**
 * `<NativeProjectList …>` の開始タグだけを切り出す。ファイル全文に `onCollapse` が無いことを
 * 見る書き方だと、同じファイルの別用途の `onCollapse`（選択を 1 件外すハンドラ）で落ちる。
 * 検査したいのは「この要素へ渡していない」ことなので、要素の属性の中だけを見る。
 * `{}` の入れ子と文字列を数えながら、深さ 0 の `/>` または `>` で終わらせる。
 */
const openingTags=(source:string,name:string):string[]=>{
  const tags:string[]=[];
  for(let at=source.indexOf(`<${name}`);at>=0;at=source.indexOf(`<${name}`,at+1)){
    if(/[\w$]/.test(source[at+1+name.length]??''))continue;   // <NativeProjectListItem のような別名を拾わない
    let depth=0,quote='';
    for(let i=at+1+name.length;i<source.length;i++){
      const ch=source[i]!;
      if(quote){if(ch===quote&&source[i-1]!=='\\')quote='';continue;}
      if(ch==='\''||ch==='"'||ch==='`'){quote=ch;continue;}
      if(ch==='{')depth++;
      else if(ch==='}')depth--;
      else if(depth===0&&ch==='>'){tags.push(source.slice(at,i+1));break;}
    }
  }
  return tags;
};
it('左パネルの畳むボタンは 1 つだけ（NativeProjectList へは渡さない）',()=>{
  const tags=openingTags(workspace,'NativeProjectList');
  expect(tags,'NativeWorkspace に <NativeProjectList> が無い（検査が空振りしている）').toHaveLength(1);
  expect(tags[0]).not.toContain('onCollapse');
  expect(readFileSync('src/app/native/NativeProjectList.tsx','utf8')).not.toContain('onCollapse');
});
it('レールはタブの一覧（アイコン）を受け取り、縦書きラベルを渡さない',()=>{
  expect(workspace).toContain('items={LEFT_RAIL_ITEMS}');
  expect(workspace).toContain('items={RIGHT_RAIL_ITEMS}');
  expect(workspace).not.toMatch(/NativeColumnRail[^\n]*label=/);
});
it('右カラムのタブ列は畳むボタンと同じ行に置かない（F5）',()=>{
  expect(workspace).toMatch(/native-dock-head[\s\S]{0,600}native-column-collapse/);
  expect(workspace).not.toMatch(/native-dock-tabs[\s\S]{0,300}native-column-collapse/);
});
it('畳むボタンは native-header-icon の固定正方形（width/height:var(--btn-h)）を上書きし、アイコン＋文字を収める幅を持つ',()=>{
  const css=readFileSync('src/app/native/native-restoration.css','utf8');
  const rule=css.match(/\.native-column-collapse\.native-header-icon\s*\{([^}]*)\}/);
  expect(rule).not.toBeNull();
  expect(rule![1]).toMatch(/width\s*:\s*auto/);
});

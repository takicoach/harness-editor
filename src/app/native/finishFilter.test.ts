import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const polish=readFileSync(join(__dirname,'native-polish.css'),'utf8');
const inspector=readFileSync(join(__dirname,'NativeInspector.tsx'),'utf8');

/**
 * I-2: 仕上げ→字幕・テロップのフィルタは `data-setting` を持つ節を子孫まで隠すので、captions 節の
 * 中に入れ子で描く「動きのカタログ」（data-setting=animation-list）も巻き込んでいた。除外を字句で固定する
 * （jsdom は display の実効値を解けないのでソース検査。監査側の可視検査は native-inspector-audit.ts）。
 */
describe('仕上げフィルタ（字幕・テロップ）',()=>{
  it('入れ子の「動きのカタログ」は captions の 2 規則から除外する',()=>{
    const rules=polish.split('\n').filter(line=>line.includes('[data-finish-tool=captions]'));
    const nested=rules.filter(line=>/section\[data-setting\]:not\(\[data-setting=captions\]\)|\[data-group\]>div>section:not\(\[data-setting=captions\]\)/.test(line));
    expect(nested).toHaveLength(2);   // 対象の規則がそこに実在するかの存在検査
    for(const rule of nested)expect(rule).toContain(':not([data-setting=captions]):not([data-setting=animation-list])');
  });
  /**
   * T9: 速度の節は fieldset>section で data-setting を持たないので、上の規則では隠れない。
   * M-9': 隠すのは許可リスト方式の 3 つ（captions / color / audio）だけ。`layout`（動き・配置）と
   * `fades`（シーン転換）は「名指しで消す除外リスト」方式なので、速度は従来どおり残す。
   */
  it('字幕・カラー・音声の絞り込みでだけ速度の節（fieldset>section）を畳む',()=>{
    const rules=polish.split('\n').filter(line=>line.includes('.native-speed-settings{display:none}'));
    expect(rules).toHaveLength(1);   // 対象の規則がそこに実在するかの存在検査
    for(const tool of ['captions','color','audio'])
      expect(rules[0]).toContain(`.native-right-dock[data-finish-tool=${tool}] .native-inspector .native-speed-settings`);
    for(const tool of ['layout','fades'])
      expect(rules[0]).not.toContain(`[data-finish-tool=${tool}] .native-inspector .native-speed-settings`);
    expect(rules[0]).not.toContain(':not([data-finish-tool=all])');   // 除外リスト方式に戻していない
    expect(polish).not.toMatch(/\.native-speed-settings\{display:none\s*!important/);
  });
  it('動きのカタログは captions 節の中の入れ子節である（除外が効く前提）',()=>{
    expect(inspector).toContain('<NativeInspectorSection setting="animation-list"');
    expect(inspector).toMatch(/<section data-setting="captions">[\s\S]*?setting="animation-list"/);
  });
});

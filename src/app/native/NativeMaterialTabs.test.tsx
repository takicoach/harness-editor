/** @vitest-environment jsdom */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,render} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import {NativeSegmented} from './NativeSegmented';
import {materialTabItems} from './materialTab';
import {fixture} from '../../core/sequence/fixtures';

beforeEach(()=>{
  Object.defineProperty(HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return 80;}});
  Object.defineProperty(HTMLElement.prototype,'offsetLeft',{configurable:true,get(){return 0;}});
  Object.defineProperty(HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return 80;}});
  Object.defineProperty(HTMLElement.prototype,'offsetTop',{configurable:true,get(){return 0;}});
  Object.defineProperty(HTMLElement.prototype,'clientHeight',{configurable:true,get(){return 80;}});
  vi.stubGlobal('ResizeObserver',class{observe(){} disconnect(){}});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('素材の種類は 4 タブで、ラベルに件数が付く',()=>{
  const doc=fixture();
  const view=render(<NativeSegmented role="tablist" label="素材の種類" items={materialTabItems(doc,doc.assets)} value="video" onChange={vi.fn()}/>);
  expect(view.getAllByRole('tab').map(node=>node.textContent)).toEqual(['動画 1','画像 0','BGM 0','効果音 0']);
  expect(view.getByRole('tab',{name:'動画 1'}).getAttribute('aria-selected')).toBe('true');
});

const workspace=readFileSync('src/app/native/NativeWorkspace.tsx','utf8');
it('固定 2 件の MATERIAL_TABS を持たない',()=>{
  expect(workspace).not.toContain("{value:'assets',label:'動画・画像'}");
  expect(workspace).not.toContain("value={tab==='music'?'music':'assets'}");
});
it('取り込み後は materialTabOf が返すタブへ切り替える（setTab の固定値を残さない）',()=>{
  expect(workspace).not.toContain("setTab('assets')");
  expect(workspace).not.toContain("setTab('music')");
  expect(workspace).toContain('revealAsset');
});
it('LUT は動画タブの details の中で .native-asset-list に残す',()=>{
  expect(workspace).toContain('カラー設定（LUT）');
  expect(workspace).toMatch(/native-asset-list[\s\S]{0,4000}<details open/);
});

const restorationCss=readFileSync('src/app/native/native-restoration.css','utf8');
it('素材タブ（.native-material-tabs）は既定の左カラム幅で折り返さない専用ルールを持つ（jsdom は実測できないため CSS ソースを検査）',()=>{
  // 2026-09-17 レビュー修正: 4 タブ（動画・画像・BGM・効果音）が左カラム既定幅 248px で
  // 2 行に折り返し「効果音 0」だけ 2 行目に落ちていた。折り返し禁止＋横スクロール退避で 1 行に収める。
  expect(restorationCss).toMatch(/\.native-material-tabs\s*\{[^}]*flex-wrap:\s*nowrap/);
  expect(restorationCss).toMatch(/\.native-material-tabs>button\s*\{[^}]*padding:\s*4px 6px/);
});

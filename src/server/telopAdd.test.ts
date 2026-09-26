import {expect,it} from 'vitest';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {TELOP_ADD_MANAGED_DIR,inspectTelopFolder,telopAdd} from './telopAdd';

/** 管理領域（.sme/telop-packs）に何も残っていないこと（一時フォルダ含む）。 */
function managedDirIsEmpty(project:string):boolean {
  const dir=join(project,TELOP_ADD_MANAGED_DIR);
  return !existsSync(dir)||readdirSync(dir).length===0;
}

function fixture(build:(dir:string)=>void){const dir=mkdtempSync(join(tmpdir(),'telop-add-'));build(dir);return dir;}

it('accepts the editor pack shape（manifest.ts ＋ styles/）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'manifest.ts'),`export const TELOP_PACK=[{id:1,name:'白ふち'},{id:2,name:'黒帯'}];`);
    mkdirSync(join(d,'styles'));writeFileSync(join(d,'styles','style1.tsx'),'export default null;');
  });
  const report=inspectTelopFolder(dir);
  expect(report.kind).toBe('pack');
  expect(report.ids).toEqual([1,2]);
  expect(report.names).toEqual(['白ふち','黒帯']);
});
it('accepts the project-template shape（telopStyles*.ts ＋ TEMPLATE_MAP）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow={};export const template32_handwrittenMarker={};`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow,32:template32_handwrittenMarker};`);
  });
  const report=inspectTelopFolder(dir);
  expect(report.kind).toBe('template');
  expect(report.ids).toEqual([31,32]);
});
it('refuses a template folder that reaches outside the selected folder（C4）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow=()=>null;`);
    writeFileSync(join(d,'Telop.tsx'),`import {TELOP_CONFIG} from '../videoConfig';\nconst TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  expect(()=>inspectTelopFolder(dir)).toThrow(/案件の設定ファイルに依存/);
});
it('refuses the bundled project-template folder with that same reason（C4）',()=>{
  const bundled=fileURLToPath(new URL('../../project-template/src/テロップテンプレート',import.meta.url));
  expect(()=>inspectTelopFolder(bundled)).toThrow(/単体では取り込めません/);
});
it('still accepts a template folder whose imports stay inside it, transitively（C4）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`import {tint} from './shared';\nexport const template31_neonGlow=()=>tint();`);
    writeFileSync(join(d,'shared.ts'),`export const tint=()=>null;`);
    writeFileSync(join(d,'Telop.tsx'),`import React from 'react';\nimport {template31_neonGlow} from './telopStylesExtra';\nconst TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  expect(inspectTelopFolder(dir).ids).toEqual([31]);
});
it('refuses a template folder whose nested local file reaches outside（C4）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`import {tint} from './shared';\nexport const template31_neonGlow=()=>tint();`);
    writeFileSync(join(d,'shared.ts'),`export {TELOP_CONFIG as tint} from '../videoConfig';`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  expect(()=>inspectTelopFolder(dir)).toThrow(/単体では取り込めません/);
});
it('accepts a subfolder file whose own ../ import still stays inside the folder（Codex#5）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'Telop.tsx'),`import {tint} from './parts/style';\nexport const template31_neonGlow=()=>tint();\nconst TEMPLATE_MAP={31:template31_neonGlow};`);
    writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow2=()=>null;`);
    mkdirSync(join(d,'parts'));
    writeFileSync(join(d,'parts','style.ts'),`export {tint} from '../shared';`);
    writeFileSync(join(d,'shared.ts'),`export const tint=()=>null;`);
  });
  expect(inspectTelopFolder(dir).ids).toEqual([31]);
});
it('still refuses when a subfolder file´s ../ import escapes the selected folder（Codex#5）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`import {tint} from './parts/style';\nexport const template31_neonGlow=()=>tint();`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow};`);
    mkdirSync(join(d,'parts'));
    writeFileSync(join(d,'parts','style.ts'),`export {tint} from '../../videoConfig';`);
  });
  expect(()=>inspectTelopFolder(dir)).toThrow(/単体では取り込めません/);
});
it('accepts import type from outside the folder（R3-M1）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`import type {X} from '../videoConfig';\nexport const template31_neonGlow=()=>null;`);
    writeFileSync(join(d,'Telop.tsx'),`export type {X} from '../videoConfig';\nconst TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  expect(inspectTelopFolder(dir).ids).toEqual([31]);
});
it('refuses a bare external dependency with a different reason than a folder-escape（R3-M2）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`import _ from 'lodash';\nexport const template31_neonGlow=()=>_.noop();`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  expect(()=>inspectTelopFolder(dir)).toThrow(/このフォルダに無いモジュール.*lodash/);
});
it('refuses a folder-internal dynamic import instead of failing later at compile time（R3-M3）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow=()=>import('./shared');`);
    writeFileSync(join(d,'shared.ts'),`export default null;`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  expect(()=>inspectTelopFolder(dir)).toThrow(/動的/);
});
it('refuses a folder that is neither, and says what to pick',()=>{
  const dir=fixture(d=>writeFileSync(join(d,'readme.txt'),'x'));
  expect(()=>inspectTelopFolder(dir)).toThrow(/zip を展開したフォルダ/);
});
it('refuses a zip file instead of silently reading nothing',()=>{
  const dir=fixture(d=>writeFileSync(join(d,'pack.zip'),'PK'));
  expect(()=>inspectTelopFolder(dir)).toThrow(/zip を展開したフォルダ/);
});


// R2-I1: 版は「形が確定してから」スタイルの材料だけを読む。以前はフォルダ配下の
// 全バイトを、形の判定より前に無制限で同期読みしていた。
it.runIf(process.getuid?.()!==0)('下見は形に関係ないファイルを読まない（R2-I1）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow=()=>null;`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow};`);
    // 読もうとすれば EACCES で落ちる無関係ファイル（「読んでいない」ことの観測）。
    const blocked=join(d,'素材.bin');writeFileSync(blocked,'x');chmodSync(blocked,0o000);
  });
  expect(inspectTelopFolder(dir).ids).toEqual([31]);
});
it('版の材料が多すぎるフォルダは読み切らずに断る（R2-I1）',()=>{
  const dir=fixture(d=>{
    writeFileSync(join(d,'manifest.ts'),`export const TELOP_PACK=[{id:1,name:'白ふち'}];`);
    mkdirSync(join(d,'styles'));
    for(let index=0;index<1100;index++)writeFileSync(join(d,'styles',`style${index}.tsx`),'export default null;');
  });
  expect(()=>inspectTelopFolder(dir)).toThrow(/大きすぎ/);
});

it('refuses a pack whose numbers collide, writing nothing',async()=>{
  const project=fixture(d=>mkdirSync(join(d,'src','テロップテンプレート'),{recursive:true}));
  const pack=fixture(d=>{writeFileSync(join(d,'manifest.ts'),`export const TELOP_PACK=[{id:1,name:'白ふち'}];`);mkdirSync(join(d,'styles'));});
  await expect(telopAdd(project,pack,[1])).rejects.toThrow(/同じ番号/);
  expect(existsSync(join(project,'.sme','telop-packs'))).toBe(false);
});
it('refuses to overwrite a project that carries the product signature',async()=>{
  const project=fixture(d=>{mkdirSync(join(d,'src','テロップテンプレート'),{recursive:true});
    writeFileSync(join(d,'src','テロップテンプレート','telopStyles.ts'),'// TAKICOACH_TELOP_STYLES v1\n');});
  const pack=fixture(d=>{writeFileSync(join(d,'manifest.ts'),`export const TELOP_PACK=[{id:90,name:'x'}];`);mkdirSync(join(d,'styles'));});
  await expect(telopAdd(project,pack,[])).rejects.toThrow(/製品同梱/);
});

it('leaves no orphaned folder in .sme/telop-packs when the compile fails（pack: Telop.tsx が無い）',async()=>{
  const project=fixture(d=>mkdirSync(join(d,'src','テロップテンプレート'),{recursive:true}));
  const pack=fixture(d=>{
    writeFileSync(join(d,'manifest.ts'),`export const TELOP_PACK=[{id:1,name:'白ふち'}];`);
    mkdirSync(join(d,'styles'));writeFileSync(join(d,'styles','style1.tsx'),'export default null;');
  });
  await expect(telopAdd(project,pack,[])).rejects.toThrow();
  expect(managedDirIsEmpty(project)).toBe(true);
});

it('leaves no orphaned folder in .sme/telop-packs when the compile fails（template: Telop.tsx が無い）',async()=>{
  const project=fixture(d=>mkdirSync(join(d,'src','テロップテンプレート'),{recursive:true}));
  const pack=fixture(d=>writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow=()=>null;`));
  await expect(telopAdd(project,pack,[])).rejects.toThrow();
  expect(managedDirIsEmpty(project)).toBe(true);
});

it('accepts the project-template shape end-to-end and freezes a component with a catalog',async()=>{
  const project=fixture(d=>mkdirSync(join(d,'src','テロップテンプレート'),{recursive:true}));
  const pack=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow=()=>null;`);
    writeFileSync(join(d,'Telop.tsx'),`import {template31_neonGlow} from './telopStylesExtra';\nexport function Telop(){return template31_neonGlow();}\nconst TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  const result=await telopAdd(project,pack,[]);
  expect(result.kind).toBe('template');
  expect(result.added).toEqual([31]);
  expect(result.conflicts).toEqual([]);
  expect(result.asset.textStyleCatalog?.entries).toEqual([{id:31,name:'スタイル 31'}]);
  expect(result.asset.kind).toBe('component');
  expect(managedDirIsEmpty(project)).toBe(false);
});

it('下見（inspectTelopFolder）は案件にも取り込み元にも何も書かない（I-1 の 1 段目）',()=>{
  const project=fixture(d=>mkdirSync(join(d,'src','テロップテンプレート'),{recursive:true}));
  const pack=fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow=()=>null;`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  const before=readdirSync(pack).sort();
  const report=inspectTelopFolder(pack);
  expect(report.ids).toEqual([31]);
  expect(managedDirIsEmpty(project)).toBe(true);
  expect(existsSync(join(project,'.harness'))).toBe(false);
  expect(readdirSync(pack).sort()).toEqual(before);
});

it('版はフォルダの内容から決まる（同じ番号・名前でも中身が違えば別版）',()=>{
  const build=(body:string)=>fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow=()=>${body};`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  const first=inspectTelopFolder(build('null')),second=inspectTelopFolder(build('undefined'));
  expect(first.ids).toEqual(second.ids);
  expect(first.version).not.toBe(second.version);
  // 同じ中身なら何度読んでも同じ版（取り込み前の下見と本番で食い違わない）。
  expect(inspectTelopFolder(build('null')).version).toBe(first.version);
});


it('版はテンプレート形式の同梱ヘルパーが変わっても変わる（R3-I1）',()=>{
  const build=(body:string)=>fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`import {clamp} from './telopPositionMath';\nexport const template31_neonGlow=()=>clamp();`);
    writeFileSync(join(d,'telopPositionMath.ts'),`export const clamp=()=>${body};`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow};`);
  });
  const first=inspectTelopFolder(build('0')),second=inspectTelopFolder(build('1'));
  expect(first.ids).toEqual(second.ids);
  expect(first.version).not.toBe(second.version);
});
it('版はテンプレート形式で無関係ファイルを変えても変わらない（R3-I1）',()=>{
  const build=(body:string)=>fixture(d=>{
    writeFileSync(join(d,'telopStylesExtra.tsx'),`export const template31_neonGlow=()=>null;`);
    writeFileSync(join(d,'Telop.tsx'),`const TEMPLATE_MAP={31:template31_neonGlow};`);
    writeFileSync(join(d,'README.md'),body);
  });
  const first=inspectTelopFolder(build('a')),second=inspectTelopFolder(build('bbbbb'));
  expect(first.version).toBe(second.version);
});
it('版は pack 形式で Telop.tsx が変わっても変わる（R3-I1）',()=>{
  const build=(body:string)=>fixture(d=>{
    writeFileSync(join(d,'manifest.ts'),`export const TELOP_PACK=[{id:1,name:'白ふち'}];`);
    mkdirSync(join(d,'styles'));writeFileSync(join(d,'styles','style1.tsx'),'export default null;');
    writeFileSync(join(d,'Telop.tsx'),`export function Telop(){return ${body};}`);
  });
  const first=inspectTelopFolder(build('null')),second=inspectTelopFolder(build('undefined'));
  expect(first.version).not.toBe(second.version);
});

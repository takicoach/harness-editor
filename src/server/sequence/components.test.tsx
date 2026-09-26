import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileFunction } from 'node:vm';
import { transform } from 'esbuild';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as frameRuntime from '../../captureRuntime';
import { compileSequenceComponent, freezeSequenceComponent, NATIVE_FRAME_MODULE, readSequenceComponent } from './components';
import {declaredTextStyleIds,prepareNativeTextStyles} from './textStyles';
import {TELOP_PACK} from '../telopPack/manifest';

const directories: string[] = [];
async function project(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'harness-frozen-component-')); directories.push(directory);
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src/Telop.tsx'), source);
  return directory;
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('immutable native rendering components', () => {
  it.each(['remotion', NATIVE_FRAME_MODULE])('binds live swatch filenames without changing literal percent signs or other projects (%s)', async api => {
    const directory = await project(`import {staticFile} from '${api}'; export const Telop = ({segment}) => staticFile(segment.text);`);
    const load = async (id: string) => {
      const bytes = await compileSequenceComponent(directory, 'src/Telop.tsx', 'Telop', '', `/api/asset?${new URLSearchParams({ id })}&path=`);
      const compiled = await transform(new TextDecoder().decode(bytes), { format: 'cjs', platform: 'node' });
      const module = { exports: {} as { Telop(props: { segment: { text: string } }): string } };
      compileFunction(compiled.code, ['require', 'module', 'exports'])((name: string) => {
        if (name !== NATIVE_FRAME_MODULE) throw new Error(`Unexpected dependency: ${name}`);
        return { ...frameRuntime, staticFile: () => { throw new Error('static swatch asset must not use the shared resolver'); } };
      }, module, module.exports);
      return module.exports.Telop;
    };
    const first = await load('A & 案件'), second = await load('B');
    for (const text of ['100%.png', 'literal%20name.png', '日本語 #?&.png', '/images/a.png']) {
      for (const [Telop, id] of [[first, 'A & 案件'], [second, 'B']] as const) {
        const url = new URL(Telop({ segment: { text } }), 'http://localhost');
        expect(url.searchParams.get('id')).toBe(id);
        expect(url.searchParams.get('path')).toBe(text.startsWith('/') ? text.slice(1) : text);
      }
    }
  });
  it('finds candidates from declared frozen adapters, including custom IDs outside the standard pack',()=>{
    expect(declaredTextStyleIds(`if(segment.template===72){} if(9==segment.template){} switch(segment.template){case 4:break;case 72:break;} if(other.value===99){}`)).toEqual([4,9,72]);
    expect(declaredTextStyleIds(`const STYLES=[A,B,C];STYLES[resolveTemplateIndex(segment.template,STYLES.length)]`)).toEqual([1,2,3]);
    expect(declaredTextStyleIds(`const STYLES=[A,B,C]; other(segment.style,STYLES.length)`)).toEqual([]);
  });
  it('adds a self-contained native pack without changing old sources and renders every catalog entry',async()=>{
    const source='export const Telop = () => <span>案件独自の字幕</span>;',directory=await project(source);
    const asset=await prepareNativeTextStyles(directory),original=await readSequenceComponent(directory,asset);
    expect(await readFile(join(directory,'src/Telop.tsx'),'utf8')).toBe(source);
    expect(await prepareNativeTextStyles(directory)).toEqual(asset);
    expect(original).not.toMatch(/from ["'](?:remotion|@remotion\/)/);
    const compiled=await transform(original,{format:'cjs',platform:'node'});
    const module={exports:{} as {Telop:React.ComponentType<{segment:unknown}>;NATIVE_TEXT_STYLE_CATALOG:unknown}};
    const modules:Record<string,unknown>={react:React,'react/jsx-runtime':jsxRuntime,[NATIVE_FRAME_MODULE]:frameRuntime};
    compileFunction(compiled.code,['require','module','exports'])((name:string)=>{if(!(name in modules))throw new Error(`Unexpected dependency: ${name}`);return modules[name];},module,module.exports);
    expect(module.exports.NATIVE_TEXT_STYLE_CATALOG).toEqual(asset.textStyleCatalog);
    // entries はスタイル単位の能力宣言も運ぶ（裁定 5）。マニフェストの写しであることを固定する。
    expect(asset.textStyleCatalog?.entries).toEqual(TELOP_PACK.map(({id,name,animations})=>({id,name,animations:[...animations]})));
    for(const entry of TELOP_PACK){
      const html=renderToStaticMarkup(<frameRuntime.CaptureFrameProvider frame={30} videoConfig={{fps:30,width:1920,height:1080,durationInFrames:60}}><module.exports.Telop segment={{id:1,text:'自分らしい書式',template:entry.id,startFrame:0,endFrame:60,animation:'none'}} /></frameRuntime.CaptureFrameProvider>);
      expect(html.replace(/<[^>]*>/g,''),entry.name).toContain('自分らしい書式');
      expect(html,entry.name).not.toContain('NaN');
    }
  });
  it('retains the old caption and local dependencies after source edits, using the shared native frame context', async () => {
    const directory = await project(`import {useCurrentFrame} from 'remotion'; import {label} from './label';
      export const Telop = () => <span>{label}:{useCurrentFrame()}</span>;`);
    await writeFile(join(directory, 'src/label.ts'), "export const label = '元の字幕';");
    const asset = await freezeSequenceComponent(directory, 'src/Telop.tsx', 'Telop');
    const original = await readSequenceComponent(directory, asset);
    expect(original).not.toMatch(/from ["']remotion/);
    expect(original).toContain(NATIVE_FRAME_MODULE);
    expect(await freezeSequenceComponent(directory, 'src/Telop.tsx', 'Telop')).toEqual(asset);
    await writeFile(join(directory, 'src/label.ts'), "export const label = '変更後';");
    await writeFile(join(directory, 'src/Telop.tsx'), 'export const Telop = () => null;');
    expect(await readSequenceComponent(directory, asset)).toBe(original);
    const compiled = await transform(original, { format: 'cjs', platform: 'node' });
    const module = { exports: {} as { Telop: React.ComponentType } };
    const modules: Record<string, unknown> = { react: React, 'react/jsx-runtime': jsxRuntime, [NATIVE_FRAME_MODULE]: frameRuntime };
    compileFunction(compiled.code, ['require', 'module', 'exports'])((name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected runtime dependency: ${name}`);
      return modules[name];
    }, module, module.exports);
    const html = renderToStaticMarkup(<frameRuntime.CaptureFrameProvider frame={17}
      videoConfig={{ fps: 30, width: 1920, height: 1080, durationInFrames: 100 }}><module.exports.Telop /></frameRuntime.CaptureFrameProvider>);
    expect(html).toBe('<span>元の字幕:17</span>');
  });
  it('detects modified saved bytes instead of rebuilding from the old source', async () => {
    const directory = await project('export const Telop = () => null;');
    const asset = await freezeSequenceComponent(directory, 'src/Telop.tsx', 'Telop');
    await writeFile(join(directory, asset.file), 'changed');
    await expect(readSequenceComponent(directory, asset)).rejects.toThrow(/変更/);
    await expect(freezeSequenceComponent(directory, 'src/Telop.tsx', 'Telop')).rejects.toThrow(/変更/);
    expect(await readFile(join(directory, asset.file), 'utf8')).toBe('changed');
  });
  it('audits unsupported APIs through local barrels before committing a component', async () => {
    const directory = await project(`import {Video} from './barrel'; export const Telop = () => <Video />;`);
    await writeFile(join(directory, 'src/barrel.ts'), "export {Video} from 'remotion';");
    await expect(freezeSequenceComponent(directory, 'src/Telop.tsx', 'Telop')).rejects.toThrow(/Video/);
  });
  it.each([
    `import * as frame from 'remotion'; export const Telop = () => frame.useCurrentFrame();`,
    `export const Telop = () => import('./later');`,
    `import {Audio} from '@remotion/media'; export const Telop = () => <Audio />;`,
  ])('refuses unsupported or dynamic dependencies: %s', async source => {
    const directory = await project(source);
    await expect(freezeSequenceComponent(directory, 'src/Telop.tsx', 'Telop')).rejects.toThrow();
  });
  it('refuses outside source symlinks and managed destination symlinks', async () => {
    const directory = await project(`import {text} from './outside'; export const Telop = () => text;`);
    const outside = await project("export const text = 'outside';");
    await symlink(join(outside, 'src/Telop.tsx'), join(directory, 'src/outside.ts'));
    await expect(freezeSequenceComponent(directory, 'src/Telop.tsx', 'Telop')).rejects.toThrow(/プロジェクト外/);
    await writeFile(join(directory, 'src/Telop.tsx'), 'export const Telop = () => null;');
    await symlink(outside, join(directory, '.harness'));
    await expect(freezeSequenceComponent(directory, 'src/Telop.tsx', 'Telop')).rejects.toThrow(/保存先/);
  });
  it('compiles the current component catalog caption and image without a Remotion package in the copied project', async () => {
    const directory = await project('');
    await cp(resolve('project-template/src'), join(directory, 'src'), { recursive: true });
    for (const [entry, name] of [['src/テロップテンプレート/Telop.tsx', 'Telop'], ['src/InsertImage/InsertImage.tsx', 'InsertImage']] as const) {
      const asset = await freezeSequenceComponent(directory, entry, name);
      const code = await readSequenceComponent(directory, asset);
      expect(code).not.toMatch(/from ["'](?:remotion|@remotion\/)/);
      expect(asset.name).toBe(name);
    }
  });
});

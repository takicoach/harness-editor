import {expect,it} from 'vitest';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findInstalledTextStylePacks,prepareInstalledTextStylePack} from './installedTextStylePacks';
import {prepareNativeTextStyleAssets,textStyleAssetsToRegister} from './textStyles';
import {fixture} from '../../core/sequence/fixtures';
import {applySequenceCommand} from '../../core/sequence/commands';

const INFO={packId:'test.extra',name:'試験用の追加パック',tabLabel:'試験',groupLabel:'試験パック',count:2,animations:['none']};
const TELOP=`export const TEMPLATE_MAP={1:{},2:{}};\nexport function Telop({segment}){return TEMPLATE_MAP[segment.template]??null;}\n`;

function serverDir(withPack:boolean):string{
  const root=mkdtempSync(join(tmpdir(),'installed-packs-'));
  mkdirSync(join(root,'telopPack'));writeFileSync(join(root,'telopPack','pack.json'),JSON.stringify({id:'telop-pack',version:'1.1.0'}));
  if(withPack){
    mkdirSync(join(root,'extraPack'));
    writeFileSync(join(root,'extraPack','textStylePack.json'),JSON.stringify(INFO));
    writeFileSync(join(root,'extraPack','manifest.json'),JSON.stringify([{id:1,name:'一'},{id:2,name:'二'}]));
    writeFileSync(join(root,'extraPack','Telop.tsx'),TELOP);
  }
  return root;
}

it('追加パックが無ければ空（有料テロップパックの pack.json は追加パックとして数えない）',()=>{
  const root=serverDir(false);
  try{expect(findInstalledTextStylePacks(root)).toEqual([]);}finally{rmSync(root,{recursive:true,force:true});}
});

it('textStylePack.json のあるフォルダを追加パックとして読み、凍結すると installed のカタログになる',async()=>{
  const root=serverDir(true),project=mkdtempSync(join(tmpdir(),'installed-project-'));
  try{
    const [pack]=findInstalledTextStylePacks(root);
    expect(pack).toMatchObject({...INFO,directory:join(root,'extraPack')});
    const asset=await prepareInstalledTextStylePack(project,pack!);
    expect(asset.name).toBe('試験用の追加パック');
    expect(Object.keys(asset.textStyleCatalog!)).toEqual(['source','packId','version','componentHash','entries','animations']);
    expect(asset.textStyleCatalog).toMatchObject({source:'installed',packId:'test.extra',entries:[{id:1,name:'一'},{id:2,name:'二'}],animations:['none']});
  }finally{rmSync(root,{recursive:true,force:true});rmSync(project,{recursive:true,force:true});}
});

it('manifest.json と count が食い違えば凍結しない',async()=>{
  const root=serverDir(true),project=mkdtempSync(join(tmpdir(),'installed-project-'));
  try{
    const [pack]=findInstalledTextStylePacks(root);
    await expect(prepareInstalledTextStylePack(project,{...pack!,count:3})).rejects.toThrow('manifest.json は 2 件');
  }finally{rmSync(root,{recursive:true,force:true});rmSync(project,{recursive:true,force:true});}
});

it('追加パックが無い配布物では、本体パックだけを用意する',async()=>{
  const project=mkdtempSync(join(tmpdir(),'installed-project-'));
  try{
    const assets=await prepareNativeTextStyleAssets(project,fixture(),[]);
    expect(assets.map(asset=>asset.textStyleCatalog?.source)).toEqual(['builtin']);
  }finally{rmSync(project,{recursive:true,force:true});}
});

it('追加パックを登録済みの作品を、パックの無い配布物で開いても、新しい資産を足さず登録済みの資産を保つ',async()=>{
  const root=serverDir(true),project=mkdtempSync(join(tmpdir(),'installed-project-'));
  try{
    const [pack]=findInstalledTextStylePacks(root);
    const opened=applySequenceCommand(fixture(),{type:'register-assets',assets:await prepareNativeTextStyleAssets(project,fixture(),[pack!])});
    const registered=opened.assets.find(asset=>asset.textStyleCatalog?.packId==='test.extra')!;
    expect(registered).toBeTruthy();
    const assets=await prepareNativeTextStyleAssets(project,opened,[]);
    expect(assets.filter(asset=>asset.textStyleCatalog?.source==='installed')).toEqual([registered]);
    expect(assets.every(asset=>opened.assets.some(item=>item.id===asset.id))).toBe(true);
    expect(textStyleAssetsToRegister(opened,assets)).toEqual([]);
  }finally{rmSync(root,{recursive:true,force:true});rmSync(project,{recursive:true,force:true});}
});

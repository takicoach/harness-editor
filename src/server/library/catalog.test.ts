import {mkdtemp,mkdir,writeFile,symlink,rm,realpath,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {libraryDirectory,libraryNotStartedYet,startDefaultLibrary,parseLibraryCatalog,readLibraryCatalog,resolveLibraryFile,listLibrary,findLibraryItem,LibraryError} from './catalog';
import {FP,sampleCatalog} from './__fixtures__/catalog';

let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'harness-library-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});

describe('libraryDirectory',()=>{
  it('uses HARNESS_LIBRARY_DIR when set',()=>{expect(libraryDirectory({HARNESS_LIBRARY_DIR:'/x/y'})).toBe('/x/y');});
  it('defaults to 素材置場 inside the project root',()=>{
    expect(libraryDirectory({HARNESS_PROJECT_ROOT:'/x/projects'})).toBe(join('/x/projects','素材置場'));
  });
  it('falls back to the legacy SME_PROJECT_ROOT, then cwd',()=>{
    expect(libraryDirectory({SME_PROJECT_ROOT:'/x/old'})).toBe(join('/x/old','素材置場'));
    expect(libraryDirectory({})).toBe(join(process.cwd(),'素材置場'));
  });
});
describe('始めていない既定の素材置場',()=>{
  it('既定の場所で台帳が無ければ「まだ始めていない」、作ると空の v2 台帳になる',async()=>{
    const lib=join(dir,'projects','素材置場');
    expect(await libraryNotStartedYet(lib,{})).toBe(true);
    await startDefaultLibrary(lib);
    expect(await libraryNotStartedYet(lib,{})).toBe(false);
    expect(await readLibraryCatalog(lib)).toEqual({version:2,packs:[],templates:[],media:[]});
  });
  it('指定した場所（HARNESS_LIBRARY_DIR）が無い時は空と取り違えない（外付けの外れ）',async()=>{
    expect(await libraryNotStartedYet(join(dir,'missing'),{HARNESS_LIBRARY_DIR:join(dir,'missing')})).toBe(false);
  });
  it('既存の catalog.json は作り直しで上書きしない',async()=>{
    await writeFile(join(dir,'catalog.json'),JSON.stringify(sampleCatalog()));
    await startDefaultLibrary(dir);
    expect(JSON.parse(await readFile(join(dir,'catalog.json'),'utf8'))).toEqual(sampleCatalog());
  });
});
describe('parseLibraryCatalog',()=>{
  it('accepts a v2 catalog',()=>{expect(parseLibraryCatalog(sampleCatalog()).templates[0]!.template).toBe(38);});
  it('rejects v1 and malformed entries',()=>{
    expect(()=>parseLibraryCatalog({templates:[],sfx:[]})).toThrow(LibraryError);
    const bad=sampleCatalog();bad.media[0]!.fingerprint='zz';expect(()=>parseLibraryCatalog(bad)).toThrow(/指紋/);
    const dup=sampleCatalog();dup.media.push({...dup.media[0]!});expect(()=>parseLibraryCatalog(dup)).toThrow(/重複/);
    const nopack=sampleCatalog();nopack.templates[0]!.packId='other';expect(()=>parseLibraryCatalog(nopack)).toThrow(/パック/);
  });
});
describe('resolveLibraryFile',()=>{
  it('resolves files inside the library for the right purpose',async()=>{
    await mkdir(join(dir,'効果音'));await writeFile(join(dir,'効果音/pop.wav'),'x');
    expect(await resolveLibraryFile(dir,'効果音/pop.wav','audio')).toBe(join(await realpath(dir),'効果音/pop.wav'));
  });
  it('rejects traversal, absolute paths, symlink escape, wrong extension and directories',async()=>{
    const outside=await mkdtemp(join(tmpdir(),'harness-outside-'));await writeFile(join(outside,'s.wav'),'x');
    await symlink(join(outside,'s.wav'),join(dir,'link.wav'));await mkdir(join(dir,'d.wav'));await writeFile(join(dir,'a.txt'),'x');
    for(const [rel,purpose] of [['../x.wav','audio'],['/etc/passwd','audio'],['link.wav','audio'],['a.txt','audio'],['d.wav','audio']] as const)
      await expect(resolveLibraryFile(dir,rel,purpose)).rejects.toThrow(LibraryError);
    await rm(outside,{recursive:true,force:true});
  });
});
describe('resolveLibraryFile hardening',()=>{
  const fail=async(rel:string,purpose:'audio'|'component'|'assetJson'|'image'|'preview',msg:RegExp,status:number)=>{
    const e=await resolveLibraryFile(dir,rel,purpose).then(()=>null,x=>x);
    expect(e).toBeInstanceOf(LibraryError);expect(e.message).toMatch(msg);expect(e.status).toBe(status);
  };
  it('rejects a symlink pointing outside as "outside"',async()=>{
    const outside=await mkdtemp(join(tmpdir(),'harness-outside-'));await writeFile(join(outside,'s.wav'),'x');
    await symlink(join(outside,'s.wav'),join(dir,'out.wav'));
    await fail('out.wav','audio',/外を指す/,400);await rm(outside,{recursive:true,force:true});
  });
  it('rejects a final-element symlink pointing inside as "link"',async()=>{
    await writeFile(join(dir,'real.wav'),'x');await symlink(join(dir,'real.wav'),join(dir,'in.wav'));
    await fail('in.wav','audio',/リンク/,400);
  });
  it('rejects an intermediate directory symlink pointing inside',async()=>{
    await mkdir(join(dir,'real'));await writeFile(join(dir,'real/a.wav'),'x');await symlink(join(dir,'real'),join(dir,'alias'));
    await fail('alias/a.wav','audio',/リンク/,400);
  });
  it('rejects reaching a prefix-sibling directory via ../',async()=>{
    const base=await mkdtemp(join(tmpdir(),'harness-sib-'));await mkdir(join(base,'lib'));await mkdir(join(base,'lib2'));await writeFile(join(base,'lib2/x.wav'),'x');
    await fail2(join(base,'lib'),'../lib2/x.wav');await rm(base,{recursive:true,force:true});
  });
  const fail2=async(d:string,rel:string)=>{await expect(resolveLibraryFile(d,rel,'audio')).rejects.toThrow(LibraryError);};
  it('accepts a legitimate file named ..foo.wav',async()=>{
    await writeFile(join(dir,'..foo.wav'),'x');
    expect(await resolveLibraryFile(dir,'..foo.wav','audio')).toBe(join(await realpath(dir),'..foo.wav'));
  });
  it('handles extensions per purpose',async()=>{
    for(const f of ['a.WAV','a.mjs','a.json','a.png'])await writeFile(join(dir,f),'x');
    await resolveLibraryFile(dir,'a.WAV','audio');await resolveLibraryFile(dir,'a.mjs','component');
    await resolveLibraryFile(dir,'a.json','assetJson');await resolveLibraryFile(dir,'a.png','image');
    await fail('a.mjs','audio',/形式/,400);
  });
  it('uses 404 for a missing file',async()=>{await fail('nope.wav','audio',/見つかりません/,404);});
});
describe('catalog.json hardening',()=>{
  it('rejects duplicate packId',()=>{
    const c=sampleCatalog() as any;c.packs=[c.packs[0],{...c.packs[0]}];
    expect(()=>parseLibraryCatalog(c)).toThrow(/台帳のパックが重複しています/);
  });
  it('refuses a catalog.json symlink pointing outside',async()=>{
    const outside=await mkdtemp(join(tmpdir(),'harness-outside-'));await writeFile(join(outside,'c.json'),JSON.stringify(sampleCatalog()));
    await symlink(join(outside,'c.json'),join(dir,'catalog.json'));
    await expect(readLibraryCatalog(dir)).rejects.toThrow(LibraryError);
    const r=await listLibrary(dir);expect(r.ok).toBe(false);if(!r.ok)expect(r.reason).toBeTruthy();
    await rm(outside,{recursive:true,force:true});
  });
  it('404 with the library message when catalog.json is absent',async()=>{
    await expect(readLibraryCatalog(dir)).rejects.toMatchObject({status:404,message:expect.stringContaining('素材置場が見つかりません')});
  });
  it('accepts .webp for preview and gives a reason for directories',async()=>{
    await writeFile(join(dir,'p.webp'),'x');await mkdir(join(dir,'d.wav'));
    expect(await resolveLibraryFile(dir,'p.webp','preview')).toMatch(/p\.webp$/);
    await expect(resolveLibraryFile(dir,'d.wav','audio')).rejects.toThrow(/通常のファイル/);
  });
});
describe('listLibrary',()=>{
  it('reports a missing library with the directory',async()=>{
    const r=await listLibrary(join(dir,'none'));expect(r.ok).toBe(false);if(!r.ok)expect(r.reason).toMatch(/見つかりません/);
  });
  it('marks items whose files are missing',async()=>{
    await writeFile(join(dir,'catalog.json'),JSON.stringify(sampleCatalog()));
    const r=await listLibrary(dir);expect(r.ok).toBe(true);if(r.ok)expect(r.missing).toEqual(expect.arrayContaining(['tpl:sample.motion:38',`se:${FP.slice(0,16)}`]));
  });
  it('finds items by key',()=>{
    const c=parseLibraryCatalog(sampleCatalog());
    expect(findLibraryItem(c,'tpl:sample.motion:38').kind).toBe('template');
    expect(()=>findLibraryItem(c,'nope')).toThrow(LibraryError);
  });
});

import {mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {MAX_DOCUMENTS} from '../shared/projectDocuments';
import {documentRelPath,listProjectDocuments,projectDocumentPath,saveProjectDocument} from './projectDocuments';
import {moveToTrash,restoreFromTrash} from './trashStore';

let root='',dir='',n=0;
const tmp=(text='本文')=>{const path=join(root,`tmp-${n++}`);writeFileSync(path,text);return path;};
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'project-docs-'));dir=join(root,'proj');mkdirSync(dir);});
afterEach(()=>rmSync(root,{recursive:true,force:true}));

describe('documentRelPath',()=>{
  it.each(['','../a.txt','a/../b.txt','/etc/a.txt','C:/a.txt','a\\b.txt','a//b.txt','.hidden/a.txt','.a.txt','a/b/c/d/e/f/g.txt'])('refuses %s',raw=>{
    expect(()=>documentRelPath(raw)).toThrow(/不正/);
  });
  it('refuses a type that is not a document',()=>expect(()=>documentRelPath('clip.mp4')).toThrow(/形式/));
  it('accepts every script format and sub-folders',()=>{
    for(const name of ['a.docx','a.PDF','a.txt','a.md','a.markdown','a.srt','台本/第1回/a.txt'])expect(documentRelPath(name)).toBe(name);
  });
});

describe('saving and listing',()=>{
  it('keeps the sub-folders and lists by path, and an empty project has none',async()=>{
    expect(await listProjectDocuments(dir)).toEqual([]);
    await saveProjectDocument(dir,'z.md',tmp('zz'));
    const saved=await saveProjectDocument(dir,'台本/a.txt',tmp('本文'));
    expect(readFileSync(join(dir,'資料','台本','a.txt'),'utf8')).toBe('本文');
    expect(saved).toEqual({path:'台本/a.txt',sizeBytes:6,absolutePath:join(dir,'資料','台本','a.txt')});
    expect((await listProjectDocuments(dir)).map(doc=>doc.path)).toEqual(['z.md','台本/a.txt']);
    expect(await projectDocumentPath(dir,'台本/a.txt')).toBe(join(dir,'資料','台本','a.txt'));
  });
  it('does not overwrite the same name',async()=>{
    await saveProjectDocument(dir,'a.txt',tmp('一'));
    await expect(saveProjectDocument(dir,'a.txt',tmp('二'))).rejects.toMatchObject({status:409});
    expect(readFileSync(join(dir,'資料','a.txt'),'utf8')).toBe('一');
  });
  it('keeps to the limit and the same-name rule when saves arrive together',async()=>{
    const same=await Promise.allSettled(Array.from({length:5},()=>saveProjectDocument(dir,'same.txt',tmp())));
    expect(same.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const many=await Promise.allSettled(Array.from({length:MAX_DOCUMENTS+5},(_,i)=>saveProjectDocument(dir,`d${i}.txt`,tmp())));
    expect(many.filter(result=>result.status==='fulfilled')).toHaveLength(MAX_DOCUMENTS-1);
    expect(await listProjectDocuments(dir)).toHaveLength(MAX_DOCUMENTS);
  });
  it('leaves other things in the folder out of the list',async()=>{
    mkdirSync(join(dir,'資料'),{recursive:true});
    writeFileSync(join(dir,'資料','clip.mp4'),'x');writeFileSync(join(dir,'資料','.hidden.txt'),'x');
    expect(await listProjectDocuments(dir)).toEqual([]);
  });
});

describe('links',()=>{
  const outside=()=>{const path=join(root,'outside');mkdirSync(path,{recursive:true});writeFileSync(join(path,'secret.txt'),'秘密');return path;};
  it('does not follow the folder itself being a link',async()=>{
    symlinkSync(outside(),join(dir,'資料'));
    expect(await listProjectDocuments(dir)).toEqual([]);
    await expect(saveProjectDocument(dir,'a.txt',tmp())).rejects.toMatchObject({status:400});
    await expect(projectDocumentPath(dir,'secret.txt')).rejects.toMatchObject({status:400});
  });
  it('does not follow a linked sub-folder or a linked file',async()=>{
    const target=outside();mkdirSync(join(dir,'資料'));
    symlinkSync(target,join(dir,'資料','sub'));symlinkSync(join(target,'secret.txt'),join(dir,'資料','link.txt'));
    expect(await listProjectDocuments(dir)).toEqual([]);
    await expect(saveProjectDocument(dir,'sub/a.txt',tmp())).rejects.toMatchObject({status:400});
    await expect(projectDocumentPath(dir,'sub/secret.txt')).rejects.toMatchObject({status:400});
    await expect(projectDocumentPath(dir,'link.txt')).rejects.toMatchObject({status:400});
  });
  it('answers 404 for a document that is not there',async()=>{
    await expect(projectDocumentPath(dir,'none.txt')).rejects.toMatchObject({status:404});
  });
});

describe('moving the project',()=>{
  it('still has its documents after going to the trash and coming back',async()=>{
    await saveProjectDocument(dir,'台本.txt',tmp('本文'));
    const entry=moveToTrash(root,'proj','project');
    expect(await listProjectDocuments(dir)).toEqual([]);
    restoreFromTrash(root,entry.id);
    expect((await listProjectDocuments(dir)).map(doc=>doc.path)).toEqual(['台本.txt']);
    expect(readFileSync(await projectDocumentPath(dir,'台本.txt'),'utf8')).toBe('本文');
  });
});

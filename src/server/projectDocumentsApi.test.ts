import {mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {HttpError,sendApiError} from './http';
import {handleApi} from './plugin';

let root='',origin='',server:Server;
const q=(path:string,id='case')=>`?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`;
const post=(path:string,body:BodyInit='本文',id?:string)=>fetch(`${origin}/api/project/documents${q(path,id)}`,{method:'POST',body});
beforeEach(async()=>{
  root=mkdtempSync(join(tmpdir(),'docs-api-'));mkdirSync(join(root,'case'));
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch((error:unknown)=>sendApiError(res,error instanceof Error?error:new HttpError(500,String(error))));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});});

describe('/api/project/documents',()=>{
  it('saves, lists and returns a document without letting the browser open it',async()=>{
    expect((await post('台本/第1回.txt')).status).toBe(200);
    expect(readFileSync(join(root,'case','資料','台本','第1回.txt'),'utf8')).toBe('本文');
    const list=await (await fetch(`${origin}/api/project/documents?id=case`)).json() as {documents:Array<{path:string;absolutePath:string}>};
    expect(list.documents.map(doc=>doc.path)).toEqual(['台本/第1回.txt']);
    const file=await fetch(`${origin}/api/project/documents/file${q('台本/第1回.txt')}`);
    expect(await file.text()).toBe('本文');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('content-disposition')).toMatch(/^attachment/);
  });
  it('refuses a path that leaves the folder, another type, and an unknown project',async()=>{
    expect((await post('../a.txt')).status).toBe(400);
    expect((await post('clip.mp4')).status).toBe(400);
    expect((await post('a.txt','x','none')).status).toBe(404);
    expect((await fetch(`${origin}/api/project/documents/file${q('../secret.txt')}`)).status).toBe(400);
    expect((await fetch(`${origin}/api/project/documents/file${q('none.txt')}`)).status).toBe(404);
  });
  it('refuses a document over the limit before keeping anything, and leaves no temporary file',async()=>{
    const big=new Blob([new Uint8Array(50*1024*1024+1)]);
    expect((await post('big.txt',big)).status).toBe(413);
    expect(readdirSync(join(root,'case'))).not.toContain('資料');
  });
  it('leaves no temporary file when the same name is refused',async()=>{
    await post('a.txt');
    expect((await post('a.txt','二')).status).toBe(409);
    expect(readdirSync(join(root,'.sme-upload-tmp'))).toEqual([]);
  });
});

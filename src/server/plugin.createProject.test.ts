import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from './plugin';
import { HttpError } from './http';
import { createSequenceProject } from './sequence/create';
import { spawnCommand } from './spawnShell';

vi.mock('./sequence/create', () => ({ createSequenceProject: vi.fn() }));
vi.mock('./spawnShell', async importOriginal => ({
  ...await importOriginal<typeof import('./spawnShell')>(),
  spawnCommand: vi.fn(() => { throw new Error('creation API must not launch an installation process'); }),
}));

const VIDEO=Buffer.from('native-project-upload-bytes');
let base:string,root:string,source:string,previousRoots:string|undefined,bodyReads:number;
beforeEach(()=>{
  base=realpathSync(mkdtempSync(join(tmpdir(),'native-create-api-')));root=join(base,'projects');
  const ssd=join(base,'ssd');mkdirSync(root);mkdirSync(ssd);source=join(ssd,'take.mp4');writeFileSync(source,VIDEO);
  previousRoots=process.env.SME_BROWSE_ROOTS;process.env.SME_BROWSE_ROOTS=ssd;bodyReads=0;
  vi.mocked(createSequenceProject).mockImplementation(async (_root,input)=>{
    expect(readFileSync(input.sourcePath)).toEqual(VIDEO);
    return {id:input.name};
  });
});
afterEach(()=>{
  expect(spawnCommand).not.toHaveBeenCalled();expect(readFileSync(source)).toEqual(VIDEO);
  if(previousRoots===undefined)delete process.env.SME_BROWSE_ROOTS;else process.env.SME_BROWSE_ROOTS=previousRoots;
  rmSync(base,{recursive:true,force:true});vi.resetAllMocks();
});
async function call(path:string,method='POST',headers:Record<string,string>={},payload=path.startsWith('/api/create-project-link')?Buffer.alloc(0):VIDEO){
  let status=0,body:Record<string,unknown>={};
  const res=Object.assign(new EventEmitter(),{writableEnded:false,destroyed:false,writeHead(s:number){status=s;return this;},end(text?:string){this.writableEnded=true;body=text?JSON.parse(text):{};}}) as unknown as ServerResponse;
  const req=Object.assign(new EventEmitter(),{method,headers,url:path,aborted:false,async *[Symbol.asyncIterator](){bodyReads++;if(payload.length)yield payload;}}) as unknown as IncomingMessage;
  try{await handleApi(req,res,new URL(`http://localhost${path}`),root);}
  catch(error){if(error instanceof HttpError)return {status:error.status,body:{error:error.message}};throw error;}
  expect(req.listenerCount('aborted')).toBe(0);expect(res.listenerCount('close')).toBe(0);
  return {status,body};
}

describe('native-only project creation API',()=>{
  it.each(['/api/create-project','/api/create-project-link'])('retires %s legacy creation before reading input or probing a path',async endpoint=>{
    for(const suffix of ['','?native=0','?native=legacy']){
      const result=await call(endpoint+suffix);expect(result.status).toBe(410);expect(result.body.error).toMatch(/独自編集画面/);
    }
    expect(bodyReads).toBe(0);expect(createSequenceProject).not.toHaveBeenCalled();
  });
  it.each(['/api/create-project','/api/create-project-link'])('preserves the POST contract for %s',async endpoint=>{
    expect((await call(endpoint+'?native=1','GET')).status).toBe(405);expect(bodyReads).toBe(0);
  });
  it('streams an upload to native creation and cleans its temporary file after success',async()=>{
    const result=await call('/api/create-project?native=1&name=new-project&video=take.mp4');
    expect(result).toMatchObject({status:200,body:{id:'new-project',projects:[]}});expect(bodyReads).toBe(1);
    expect(createSequenceProject).toHaveBeenCalledTimes(1);
    const [directory,input]=vi.mocked(createSequenceProject).mock.calls[0]!;
    expect(directory).toBe(root);expect(input).toMatchObject({name:'new-project',videoName:'take.mp4'});
    expect(existsSync(input.sourcePath)).toBe(false);
  });
  it('cleans the upload after a native import failure and keeps the source untouched',async()=>{
    let temp='';vi.mocked(createSequenceProject).mockImplementation(async(_root,input)=>{
      temp=input.sourcePath;expect(readFileSync(temp)).toEqual(VIDEO);throw new HttpError(422,'動画を解析できません');
    });
    expect((await call('/api/create-project?native=1&name=bad&video=take.mp4')).status).toBe(422);
    expect(temp).not.toBe('');expect(existsSync(temp)).toBe(false);
  });
  it.each([
    ['name=..bad&video=take.mp4',400],['name=bad&video=take.txt',400],['name=existing&video=take.mp4',409],
  ])('rejects %s before reading a body',async(query,status)=>{
    mkdirSync(join(root,'existing'));expect((await call('/api/create-project?native=1&'+query)).status).toBe(status);
    expect(bodyReads).toBe(0);expect(createSequenceProject).not.toHaveBeenCalled();
  });
  it('checks upload size before reading the body',async()=>{
    const result=await call('/api/create-project?native=1&name=large&video=take.mp4','POST',{'content-length':String(64*1024**3)});
    expect(result.status).toBe(413);expect(bodyReads).toBe(0);expect(createSequenceProject).not.toHaveBeenCalled();
  });
  it.each([undefined,createHash('sha256').update(VIDEO).digest('hex')])('references an explicitly browsable path with optional fingerprint %s',async expectedFingerprint=>{
    const payload=Buffer.from(JSON.stringify(expectedFingerprint?{expectedFingerprint}:{}));
    const result=await call('/api/create-project-link?'+new URLSearchParams({native:'1',name:'local',path:source}),'POST',{'content-type':'application/json'},payload);
    expect(result).toMatchObject({status:200,body:{id:'local'}});expect(bodyReads).toBe(1);
    expect(createSequenceProject).toHaveBeenCalledTimes(1);expect(createSequenceProject).toHaveBeenCalledWith(root,{name:'local',videoName:source,sourcePath:source,reference:true,expectedFingerprint},expect.any(AbortSignal));
    expect(vi.mocked(createSequenceProject).mock.calls[0]![2]!.aborted).toBe(false);
  });
  it.each([VIDEO,Buffer.from(JSON.stringify({expectedFingerprint:'not-full-sha'}))])('rejects malformed reference metadata before creation',async payload=>{
    const result=await call('/api/create-project-link?'+new URLSearchParams({native:'1',name:'invalid',path:source}),'POST',{'content-type':'application/json'},payload);
    expect(result.status).toBe(400);expect(createSequenceProject).not.toHaveBeenCalled();
  });
  it('rejects a path outside browse authority before native import',async()=>{
    const outside=join(base,'outside.mp4');writeFileSync(outside,VIDEO);
    expect((await call('/api/create-project-link?'+new URLSearchParams({native:'1',name:'outside',path:outside}))).status).toBe(403);
    expect(createSequenceProject).not.toHaveBeenCalled();expect(bodyReads).toBe(0);
  });
});

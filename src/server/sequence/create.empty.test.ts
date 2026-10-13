import {afterEach,expect,it} from 'vitest';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleApi} from '../plugin';
import {sendApiError} from '../http';
import {SequenceStore} from './store';
import {createEmptySequenceProject} from './create';
import {buildEmptyDocument} from './createDocuments';
import {validateSequenceDocument} from '../../core/sequence/validate';
import {isUninitializedSequence} from '../../core/sequence/mainAppend';
import {mainTracks} from '../../core/sequence/mainTrack';

let root='',server:Server|undefined;
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));server=undefined;}if(root)await rm(root,{recursive:true,force:true});});
it('builds an uninitialized 1920x1080 30fps document whose empty main tracks are recorded',()=>{
  const doc=buildEmptyDocument('空',()=>'doc-1');validateSequenceDocument(doc);
  expect(doc).toMatchObject({fps:{num:30,den:1},resolution:{width:1920,height:1080},sequenceEndFrame:0,clips:[],assets:[]});
  expect(mainTracks(doc)).toEqual({videoTrackId:'v-main',audioTrackId:'a-main'});expect(isUninitializedSequence(doc)).toBe(true);
});
it('creates the project once and refuses the same name',async()=>{
  root=await mkdtemp(join(await realpath(tmpdir()),'create-empty-'));
  const {id}=await createEmptySequenceProject(root,{name:'空の案件'});
  expect(new SequenceStore(join(root,id)).load()!.document.clips).toEqual([]);
  await expect(createEmptySequenceProject(root,{name:'空の案件'})).rejects.toMatchObject({status:409});
});
it('POST /api/create-project-empty opens as a native session and the legacy form is refused',async()=>{
  root=await mkdtemp(join(await realpath(tmpdir()),'create-empty-api-'));
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(error=>sendApiError(res,error));});
  await new Promise<void>(done=>server!.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const created=await fetch(`${origin}/api/create-project-empty?native=1&name=${encodeURIComponent('空の案件')}`,{method:'POST'});
  expect(created.status).toBe(200);const {id}=await created.json() as {id:string};
  const session=await fetch(`${origin}/api/sequence/session?id=${encodeURIComponent(id)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  expect(session.status).toBe(200);expect((await session.json()).document.sequenceEndFrame).toBe(0);
  expect((await fetch(`${origin}/api/create-project-empty?name=x`,{method:'POST'})).status).toBe(410);
});

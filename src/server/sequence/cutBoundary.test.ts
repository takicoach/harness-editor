import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createServer,type Server} from 'node:http';import type {AddressInfo} from 'node:net';
import {SequenceStore} from './store';import {SequenceService} from './service';import {handleSequenceApi} from './api';import {HttpError} from '../http';
import type {SequenceDocument} from '../../core/sequence/model';
function fixture():SequenceDocument{return {schemaVersion:2,id:'case',name:'私有保存検査',revision:0,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},tracks:[{id:'v',kind:'visual',name:'図形',enabled:true}],clips:[{id:'shape',trackId:'v',name:'元の図形',startFrame:0,durationFrames:120,clock:{offset:{num:0,den:1},rate:{num:1,den:1},duration:{num:120,den:1}},content:{kind:'shape',data:{kind:'rect',x1:.2,y1:.2,x2:.8,y2:.8,color:'#fff',thickness:'medium',opacity:1}}}]};}
let root:string,project:string,server:Server|undefined;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'harness-cut-archive-'));project=join(root,'case');mkdirSync(project);new SequenceStore(project).save({document:fixture(),executionId:'initial',expectedSavedRevision:null});});
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));server=undefined;}rmSync(root,{recursive:true,force:true});});

it('serves strict boundary commands and persists grouped metadata across reopen, with one undo/redo',async()=>{
 let sessions=new SequenceService();server=createServer((req,res)=>{void handleSequenceApi(req,res,new URL(req.url!,'http://localhost'),root,sessions).catch(e=>{res.statusCode=e instanceof HttpError?e.status:500;res.end(String(e));});});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as AddressInfo).port;
 const post=async(path:string,body:unknown)=>fetch(url+'/api/sequence/'+path+'?id=case',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 let state=await (await post('session',{})).json();let serial=0;
 const command=async(command:unknown)=>{const response=await post('command',{sessionId:state.sessionId,executionId:'operation-'+(++serial),expectedRevision:state.document.revision,command});if(response.status===200)state=await response.json();return response.status;};
 expect(await command({type:'ripple-delete',startFrame:30,endFrame:60})).toBe(200);
 const entryId=state.document.cutArchive.entries[0].id,resize={type:'resize-cut-boundary',cut:{kind:'entry',id:entryId},edge:'start',target:{kind:'live',clipId:'shape',frame:20}};
 for(const wrong of [{...resize,atFrame:20},{...resize,target:{kind:'live',clipId:'shape',frame:20,localFrame:10}},{...resize,target:{kind:'archived',entryId,localFrame:1.5}}])expect(await command(wrong)).toBe(400);
 expect(await command(resize)).toBe(200);expect(state.document.sequenceEndFrame).toBe(80);expect(state.document.cutArchive.groups[0].entryIds).toHaveLength(2);
 expect(await command({type:'undo'})).toBe(200);expect(state.document.sequenceEndFrame).toBe(90);expect(state.document.cutArchive.groups).toBeUndefined();
 expect(await command({type:'redo'})).toBe(200);const grouped=structuredClone(state.document);
 expect((await post('save',{sessionId:state.sessionId,expectedRevision:state.document.revision,expectedSavedRevision:state.savedRevision,executionId:'save-group'})).status).toBe(200);
 sessions=new SequenceService();state=await (await post('session',{})).json();expect(state.document).toEqual(grouped);expect(state.canUndo).toBe(false);
 const bytes=readFileSync(new SequenceStore(project).file),group=state.document.cutArchive.groups[0],last=state.document.cutArchive.entries.find((e:{id:string})=>e.id===group.entryIds.at(-1));
 expect(await command({type:'resize-cut-boundary',cut:{kind:'group',id:group.id},edge:'start',target:{kind:'archived',entryId:last.id,localFrame:last.durationFrames}})).toBe(200);
 expect(state.document.sequenceEndFrame).toBe(120);expect(state.document.cutArchive).toBeUndefined();expect(readFileSync(new SequenceStore(project).file)).toEqual(bytes);
});

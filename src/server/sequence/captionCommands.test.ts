import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {SequenceStore} from './store';
import {SequenceService} from './service';
import {handleSequenceApi} from './api';
import {HttpError} from '../http';
import type {SequenceDocument} from '../../core/sequence/model';
import {applySequenceCommand} from '../../core/sequence/commands';
import {rational as r} from '../../core/sequence/time';
function fixture():SequenceDocument {
  const doc:SequenceDocument={schemaVersion:2,id:'case',name:'字幕API検査',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},
    assets:[{id:'asset',kind:'media',file:'media/source.mp4',name:'検査用',fingerprint:'fixture',streams:[{index:0,kind:'video',codec:'h264',duration:r(4),width:320,height:180,frameRate:r(30)}]}],
    tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'t',kind:'visual',name:'字幕',enabled:true}],clips:[
      {id:'video',trackId:'v',name:'映像',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)}},
      {id:'caption',trackId:'t',name:'前半後半',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'前半後半'}},anchor:{kind:'source',role:'visual',sourceAssetId:'asset',clipOccurrenceId:'video',sourceStart:r(0),sourceEnd:r(4)}},
    ]};
  return applySequenceCommand(doc,{type:'register-native-speed',groupId:'speed',mainClipIds:['video'],mainAudioBindings:[]});
}
let root:string,project:string,server:Server|undefined;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'harness-caption-api-'));project=join(root,'case');mkdirSync(project);new SequenceStore(project).save({document:fixture(),executionId:'initial',expectedSavedRevision:null});});
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));server=undefined;}rmSync(root,{recursive:true,force:true});});
it('uses the public command API to split, save/reopen, change speed and merge, with invalid requests atomic',async()=>{
  let service=new SequenceService();
  server=createServer((req,res)=>{void handleSequenceApi(req,res,new URL(req.url!,'http://localhost'),root,service).catch(error=>{res.statusCode=error instanceof HttpError?error.status:500;res.end(String(error));});});
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const post=(route:string,body:unknown)=>fetch(origin+'/api/sequence/'+route+'?id=case',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  let state=await (await post('session',{})).json(),execution=0;
  const command=(command:unknown)=>post('command',{sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:'command-'+(++execution),command});
  for(const invalid of [{type:'split-caption',clipId:'caption',frame:60,leftText:17,rightText:'後半'},{type:'split-caption',clipId:'caption',frame:60.5,leftText:'前半',rightText:'後半'},{type:'merge-captions',firstClipId:'caption',secondClipId:''}]){
    expect((await command(invalid)).status).toBe(400);expect((await (await post('session',{})).json()).document).toEqual(state.document);
  }
  let response=await command({type:'split-caption',clipId:'caption',frame:60,leftText:'前半',rightText:'後半'});expect(response.status).toBe(200);state=await response.json();
  const right=state.document.clips.find((c:{id:string;startFrame:number})=>c.id!=='caption'&&c.startFrame===60);expect(right).toBeDefined();
  response=await post('save',{sessionId:state.sessionId,expectedRevision:state.document.revision,expectedSavedRevision:state.savedRevision,executionId:'save-split'});expect(response.status).toBe(200);
  service=new SequenceService();state=await (await post('session',{})).json();expect(state.canUndo).toBe(false);
  response=await command({type:'set-native-global-speed',rate:r(2)});expect(response.status).toBe(200);state=await response.json();
  expect(state.document.clips.filter((c:{trackId:string})=>c.trackId==='t').map((c:{startFrame:number;durationFrames:number})=>[c.startFrame,c.durationFrames])).toEqual([[0,30],[30,30]]);
  response=await command({type:'merge-captions',firstClipId:'caption',secondClipId:right.id});expect(response.status).toBe(200);state=await response.json();
  expect(state.document.clips.filter((c:{trackId:string})=>c.trackId==='t')).toMatchObject([{id:'caption',startFrame:0,durationFrames:60,content:{data:{text:'前半後半'}}}]);
  response=await post('save',{sessionId:state.sessionId,expectedRevision:state.document.revision,expectedSavedRevision:state.savedRevision,executionId:'save-merge'});expect(response.status).toBe(200);
  expect(new SequenceStore(project).load()!.document.clips.filter(c=>c.content.kind==='telop')).toHaveLength(1);
});

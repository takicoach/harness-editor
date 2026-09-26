/** @vitest-environment jsdom */
import {createRef} from 'react';
import {flushSync} from 'react-dom';
import {act,cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {NativeInspector,type NativeInspectorHandle} from './NativeInspector';
import type {SequenceDocument} from '../../core/sequence/model';
import {SequenceSession} from '../../core/sequence/session';
import {rational as r} from '../../core/sequence/time';
import type {NativeCommand} from './api';
afterEach(cleanup);
function harness(){
  const document:SequenceDocument={schemaVersion:2,id:'duck',name:'test',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000',ducking:{enabled:false,strength:'mid'},assets:[],tracks:[],clips:[],transitions:[],transcripts:[]};
  const session=new SequenceSession('session',document),ref=createRef<NativeInspectorHandle>();let blocked=false,projectId='first',execution=0;
  const execute=(command:NativeCommand)=>session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:`duck-${++execution}`,command});
  const element=()=><NativeInspector ref={ref} projectId={projectId} document={session.document} readDocument={()=>session.document} frame={0} onSeek={()=>{}} selected={[]} disabled={blocked} externalBusy={blocked} bypassLut={false} onBypass={()=>{}} onUploadLut={()=>{}} onPrepareTextStyles={async()=>true}
    onCommand={async command=>{execute(command);view.rerender(element());return true;}}/>;
  const view=render(element());return {view,ref,session,execute,block(){blocked=true;view.rerender(element());},switchProject(){projectId='second';view.rerender(element());}};
}
it('works without a selected clip and keeps each toggle or strength change as one Undo',async()=>{
  const h=harness();expect((h.view.getByRole('button',{name:'強'}) as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>{fireEvent.click(h.view.getByRole('button',{name:'OFF'}));await h.ref.current!.flush();});
  expect(h.session.document.ducking).toEqual({enabled:true,strength:'mid'});
  await act(async()=>{fireEvent.click(h.view.getByRole('button',{name:'強'}));await h.ref.current!.flush();});
  expect(h.session.document.ducking).toEqual({enabled:true,strength:'strong'});h.execute({type:'undo'});expect(h.session.document.ducking).toEqual({enabled:true,strength:'mid'});
  h.execute({type:'undo'});expect(h.session.document.ducking).toEqual({enabled:false,strength:'mid'});
});
it('disables changes while AI owns the document',()=>{
  const h=harness();h.block();fireEvent.click(h.view.getByRole('button',{name:'OFF'}));expect(h.session.document.revision).toBe(0);
});
it('rejects a queued toggle when the project changes before dispatch',async()=>{
  const h=harness();act(()=>{fireEvent.click(h.view.getByRole('button',{name:'OFF'}));flushSync(()=>h.switchProject());});await act(async()=>{await h.ref.current!.flush();});
  expect(h.session.document.ducking.enabled).toBe(false);expect(h.view.getByRole('alert').textContent).toContain('別の処理中');
});

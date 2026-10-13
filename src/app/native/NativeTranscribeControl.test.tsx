/** @vitest-environment jsdom */
import {cleanup,fireEvent,render} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {fixture} from '../../core/sequence/fixtures';
import type {NativeSession} from './api';
import {NativeTranscribeControl} from './NativeTranscribeControl';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('tells the caller when the user starts generating, before asking the server',()=>{
  const calls:string[]=[];
  vi.stubGlobal('fetch',vi.fn((url:string)=>{calls.push(String(url));return new Promise(()=>undefined);}));
  const state={sessionId:'s',dirty:false,document:fixture()} as unknown as NativeSession,onEngage=vi.fn(()=>{calls.push('engage');});
  const view=render(<NativeTranscribeControl projectId="p" occurrenceId="audio" assetId="source" streamIndex={1} state={state} busy={false} read={()=>state} accept={()=>undefined} onEngage={onEngage}/>);
  expect(onEngage).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button',{name:'文字起こしを生成'}));
  expect(onEngage).toHaveBeenCalledOnce();
  expect(calls.slice(-2)).toEqual(['engage',expect.stringContaining('/api/sequence/transcribe?')]);
});

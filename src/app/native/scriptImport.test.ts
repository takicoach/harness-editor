import {expect,it,vi} from 'vitest';
import {importScriptFile,parseScriptText,SCRIPT_FILE_BYTES,SCRIPT_TEXT_LENGTH} from './scriptImport';
const file=(name:string,text:string)=>({name,size:new TextEncoder().encode(text).byteLength,arrayBuffer:async()=>new TextEncoder().encode(text).buffer});
it.each(['txt','md'] as const)('preserves Japanese and multiline %s text, strips BOM and normalizes newlines',kind=>{
  expect(parseScriptText('\uFEFF# 撮影台本\r\n日本語の一行。\r次の行。',kind)).toBe('# 撮影台本\n日本語の一行。\n次の行。');
});
it('keeps SRT cue order, multiline Japanese, and numeric spoken text without timestamps/indexes',()=>{
  const source='\uFEFF1\r\n00:00:01,000 --> 00:00:03,200\r\n日本語の台本\r\n次の行\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n2026\r\n最後の発話';
  expect(parseScriptText(source,'srt')).toBe('日本語の台本\n次の行\n\n2026\n最後の発話');
});
it.each(['1\n00:00:02,000 --> 00:00:01,000\n本文','1\n00:61:00,000 --> 00:62:00,000\n本文','1\n00:00:01,000 --> 00:00:02,000\n','番号だけ\n本文'])('rejects malformed or empty SRT cues: %s',source=>{
  expect(()=>parseScriptText(source,'srt')).toThrow(/SRT/);
});
it.each(['txt','md','srt'] as const)('rejects an empty %s document',kind=>expect(()=>parseScriptText(' \n',kind)).toThrow(/本文/));
it('checks the 8MB limit before reading bytes',async()=>{
  const arrayBuffer=vi.fn();await expect(importScriptFile({name:'large.pdf',size:SCRIPT_FILE_BYTES+1,arrayBuffer})).rejects.toThrow(/8MB/);expect(arrayBuffer).not.toHaveBeenCalled();
});
it('rejects >2m text without truncating and accepts the exact boundary',()=>{
  expect(()=>parseScriptText('字'.repeat(SCRIPT_TEXT_LENGTH+1),'txt')).toThrow(/200万/);
  expect(parseScriptText('字'.repeat(SCRIPT_TEXT_LENGTH),'txt').length).toBe(SCRIPT_TEXT_LENGTH);
});
it('validates UTF-8 and a supported filename before import',async()=>{
  await expect(importScriptFile({name:'bad.txt',size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer})).rejects.toThrow(/UTF-8/);
  await expect(importScriptFile(file('old.doc','本文'))).rejects.toThrow(/docx/);
  await expect(importScriptFile(file('台本.MARKDOWN','## 見出し\n本文'))).resolves.toBe('## 見出し\n本文');
});
it('rejects aborted work before reading and after asynchronous file loading',async()=>{
  const c=new AbortController(),arrayBuffer=vi.fn(async()=>{c.abort(new Error('cancelled'));return new TextEncoder().encode('本文').buffer;});
  await expect(importScriptFile({name:'a.txt',size:6,arrayBuffer},c.signal)).rejects.toThrow('cancelled');expect(arrayBuffer).toHaveBeenCalledTimes(1);
  arrayBuffer.mockClear();await expect(importScriptFile({name:'a.txt',size:6,arrayBuffer},c.signal)).rejects.toThrow('cancelled');expect(arrayBuffer).not.toHaveBeenCalled();
});

/** @vitest-environment jsdom */
import {expect,it,vi} from 'vitest';
import {importScriptFile,wordHtmlText} from './scriptImport';
const convertToHtml=vi.hoisted(()=>vi.fn());
// Vite's browser CommonJS wrapper exposes Mammoth through its default export.
vi.mock('mammoth',()=>({default:{convertToHtml,images:{imgElement:()=>({})}}}));
it('uses the browser default export and preserves Word manual breaks and paragraphs',async()=>{
  convertToHtml.mockResolvedValueOnce({value:'<p>日本語<br>次の行</p><p>別の段落</p>',messages:[]});
  const bytes=new ArrayBuffer(3);
  await expect(importScriptFile({name:'台本.docx',size:3,arrayBuffer:async()=>bytes})).resolves.toBe('日本語\n次の行\n\n別の段落\n\n');
  expect(convertToHtml).toHaveBeenCalledWith({arrayBuffer:bytes},expect.objectContaining({externalFileAccess:false,includeEmbeddedStyleMap:false}));
});
it('extracts only inert text and does not insert links, images, styles or script into the document',()=>{
  const before=document.body.innerHTML;
  expect(wordHtmlText('<p><a href="javascript:throw 1">本文</a><img src="https://invalid.test/x" onerror="throw 2"><script>throw 3</script><style>bad</style><br>&lt;文字&gt;</p>')).toBe('本文\n<文字>\n\n');
  expect(document.body.innerHTML).toBe(before);
});

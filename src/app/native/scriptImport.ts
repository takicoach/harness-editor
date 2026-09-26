/** Local-only script extraction. Document formatting never becomes executable HTML. */
export const SCRIPT_FILE_BYTES=8_000_000;
export const SCRIPT_TEXT_LENGTH=2_000_000;
export type ScriptFileKind='txt'|'md'|'srt'|'docx'|'pdf';
export const SCRIPT_FILE_ACCEPT='.docx,.pdf,.txt,.md,.markdown,.srt';

function boundedText(text:string):string {
  if(text.length>SCRIPT_TEXT_LENGTH)throw new Error('台本は200万文字以内にしてください');
  if(!text.trim())throw new Error('台本の本文が見つかりませんでした');
  return text;
}
function srtTime(value:string):number {
  const m=/^(\d{2,}):([0-5]\d):([0-5]\d),([0-9]{3})$/.exec(value);
  if(!m)throw new Error('SRTの時刻形式を確認してください');
  return Number(m[1])*3600000+Number(m[2])*60000+Number(m[3])*1000+Number(m[4]);
}
/** Keep cue order and multiline Japanese text; cue timestamps are not script prose. */
export function parseScriptText(source:string,kind:'txt'|'md'|'srt'):string {
  const text=source.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  if(kind!=='srt')return boundedText(text);
  if(!text.trim())return boundedText('');
  const blocks=text.trim().split(/\n[\t ]*\n+/),cues:string[]=[];
  for(const block of blocks){
    const lines=block.split('\n');
    if(/^\d+$/.test(lines[0]?.trim()??''))lines.shift();
    const timing=/^(\d{2,}:[0-5]\d:[0-5]\d,\d{3})[\t ]+-->[\t ]+(\d{2,}:[0-5]\d:[0-5]\d,\d{3})(?:[\t ]+.*)?$/.exec(lines.shift()?.trim()??'');
    if(!timing||srtTime(timing[2]!)<=srtTime(timing[1]!))throw new Error('SRTの開始・終了時刻を確認してください');
    const body=lines.join('\n').trim();if(!body)throw new Error('SRTに本文のない字幕があります');
    cues.push(body);
  }
  return boundedText(cues.join('\n\n'));
}

/** A disconnected template is inert: no returned HTML, URLs, or images enter the UI. */
export function wordHtmlText(html:string):string {
  const template=document.createElement('template');template.innerHTML=html;
  const parts:string[]=[];let length=0;
  const add=(value:string)=>{length+=value.length;if(length>SCRIPT_TEXT_LENGTH)throw new Error('台本は200万文字以内にしてください');parts.push(value);};
  const walk=(node:Node)=>{
    if(node.nodeType===3){add(node.textContent??'');return;}
    const tag=node instanceof Element?node.tagName.toLowerCase():'';
    if(['script','style','noscript','img'].includes(tag))return;
    if(tag==='br'){add('\n');return;}
    for(const child of Array.from(node.childNodes))walk(child);
    if(['p','h1','h2','h3','h4','h5','h6','li','tr'].includes(tag))add('\n\n');
    else if(tag==='td'||tag==='th')add('\t');
  };
  walk(template.content);return boundedText(parts.join(''));
}

async function pdfText(bytes:ArrayBuffer,signal?:AbortSignal):Promise<string> {
  const pdf=await import('pdfjs-dist');
  const {default:workerUrl}=await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  signal?.throwIfAborted();pdf.GlobalWorkerOptions.workerSrc=workerUrl;
  const task=pdf.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true});
  const abort=()=>{void task.destroy();};signal?.addEventListener('abort',abort,{once:true});
  try{
    const document=await task.promise,pages:string[]=[];let length=0;
    for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
      signal?.throwIfAborted();const page=await document.getPage(pageNumber);
      const content=await page.getTextContent();let text='',previousEnd:number|undefined;
      for(const item of content.items){
        if(!('str' in item))continue;
        const x=item.transform[4] as number;
        if(previousEnd!==undefined&&x-previousEnd>Math.abs(item.transform[0] as number)*0.25&&!/\s$/.test(text)&&item.str&&!/^\s/.test(item.str))text+=' ';
        text+=item.str;
        if(item.hasEOL){text+='\n';previousEnd=undefined;}else previousEnd=x+item.width;
      }
      pages.push(text.trim());length+=text.length+2;page.cleanup();
      if(length>SCRIPT_TEXT_LENGTH)throw new Error('台本は200万文字以内にしてください');
    }
    const text=pages.join('\n\n');
    if(text.includes('\0'))throw new Error('PDFの文字情報を正しく読み取れませんでした。Wordやテキスト形式にして読み込んでください');
    if(!text.trim())throw new Error('PDFから文字を読み取れませんでした。画像だけのPDFは、文字を選択できるPDFかWord・テキストにして読み込んでください');
    return boundedText(text);
  }finally{signal?.removeEventListener('abort',abort);await task.destroy();}
}

export async function importScriptFile(file:Pick<File,'name'|'size'|'arrayBuffer'>,signal?:AbortSignal):Promise<string> {
  signal?.throwIfAborted();
  if(file.size>SCRIPT_FILE_BYTES)throw new Error('台本ファイルは8MB以内にしてください');
  const extension=file.name.split('.').pop()?.toLowerCase();
  const kind=extension==='markdown'?'md':extension;
  if(!['txt','md','srt','docx','pdf'].includes(kind??''))throw new Error('Word（.docx）・PDF・TXT・Markdown・SRTを選んでください');
  const bytes=await file.arrayBuffer();signal?.throwIfAborted();
  if(bytes.byteLength>SCRIPT_FILE_BYTES)throw new Error('台本ファイルは8MB以内にしてください');
  let text:string;
  if(kind==='docx'){
    try{const {default:mammoth}=await import('mammoth');signal?.throwIfAborted();const converted=await mammoth.convertToHtml({arrayBuffer:bytes},{externalFileAccess:false,includeEmbeddedStyleMap:false,ignoreEmptyParagraphs:false,
      convertImage:mammoth.images.imgElement(async()=>({src:''}))});signal?.throwIfAborted();text=wordHtmlText(converted.value);}
    catch(error){signal?.throwIfAborted();if(error instanceof Error&&/200万文字|本文が見つかりません/.test(error.message))throw error;throw new Error('Wordを読み込めませんでした。.docx形式のファイルを確認してください',{cause:error});}
  }else if(kind==='pdf'){
    try{text=await pdfText(bytes,signal);}catch(error){signal?.throwIfAborted();
      if(error instanceof Error&&/PDFから文字|PDFの文字情報|200万文字/.test(error.message))throw error;
      throw new Error('PDFを読み込めませんでした。ファイルの破損やパスワード保護を確認してください',{cause:error});}
  }else{
    let source:string;try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('テキストはUTF-8で保存して読み込んでください');}
    text=parseScriptText(source,kind as 'txt'|'md'|'srt');
  }
  signal?.throwIfAborted();return boundedText(text);
}

import type { SourceTranscript, MediaStream } from './model';
import { compareTime, rational, timeNumber } from './time';

export function transcriptIdentity(value:SourceTranscript|null):string {
  return JSON.stringify(value && [value.assetId,value.streamIndex,value.words.map(word=>[word.id,word.text,word.start.num,word.start.den,word.end.num,word.end.den])]);
}

/** Whisper's millisecond output becomes source time, never edited timeline time. */
export function parseGeneratedTranscript(value:unknown,assetId:string,stream:MediaStream,runId:string):SourceTranscript {
  const input=value as {words?:unknown};
  if(!input || !Array.isArray(input.words) || input.words.length>500000)throw new Error('文字起こし結果の単語一覧が不正です');
  const words:SourceTranscript['words']=[];let previous=-1;
  for(const [index,raw] of input.words.entries()) {
    const word=raw as {text?:unknown;start?:unknown;end?:unknown};
    if(!word || typeof word.text!=='string' || word.text.length>100000 || !Number.isSafeInteger(word.start) || !Number.isSafeInteger(word.end))throw new Error('文字起こし結果の文字や時刻が不正です');
    const start=word.start as number,end=word.end as number;
    if(start<0 || end<start || start<previous)throw new Error('文字起こし結果の時刻が逆転しています');
    previous=start;
    if(!word.text.trim() || start===end)continue;
    // Integer-ms rounding can exceed the exact stream end by half a millisecond.
    if(end>timeNumber(stream.duration)*1000+1)throw new Error('文字起こし結果が原音の長さを超えています');
    const finish=rational(end,1000);
    words.push({id:`${runId}:${index}`,text:word.text,start:rational(start,1000),end:compareTime(finish,stream.duration)>0?stream.duration:finish});
  }
  if(!words.length)throw new Error('時刻付きの発話が見つかりませんでした。音声の内容を確認してください');
  return {assetId,streamIndex:stream.index,words};
}

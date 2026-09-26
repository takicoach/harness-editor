import {DEFAULT_TEXT_APPEARANCE,type ClipContent,type SequenceDocument,type TextAppearance} from './model';

export type TextContent=Extract<ClipContent,{kind:'telop'}>;
export function activeTextAppearance(content:TextContent):TextAppearance|undefined {
  const mode=content.textMode??(content.appearance?'free':'component');
  return mode==='free'?(content.appearance??DEFAULT_TEXT_APPEARANCE):undefined;
}
export function textComponentId(document:SequenceDocument,content:TextContent):string|undefined {
  return content.componentAssetId??document.rendering?.telopComponentAssetId;
}
/** Keep the inactive style, text, clock-independent data and source references intact. */
export function withTextMode(content:TextContent,textMode:'free'|'component'):TextContent {
  return {...content,textMode,...(textMode==='free'&&!content.appearance?{appearance:structuredClone(DEFAULT_TEXT_APPEARANCE)}:{})};
}

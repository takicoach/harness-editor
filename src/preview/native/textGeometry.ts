import {activeTextAppearance,type TextContent} from '../../core/sequence/textStyle';

/** Only the built-in, static inner layout has a measured placement contract. */
export function textGeometryIssue(content:TextContent):'component'|'animation'|'motion'|undefined {
  if(!activeTextAppearance(content))return 'component';
  if(content.data.animation&&content.data.animation!=='none')return 'animation';
  if(content.data.motion)return 'motion';
  return undefined;
}

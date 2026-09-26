import type {ClipVisual} from '../../core/sequence/model';

/** CaptureTitleLayer animates its inner content unless an outer animation was
 * explicitly supplied. Static editing must agree with that renderer contract.
 */
export function titleGeometryIssue(visual:ClipVisual|undefined):'inner-animation'|'animation'|undefined {
  if(!visual?.enter&&!visual?.exit)return 'inner-animation';
  if([visual.enter,visual.exit].some(item=>item&&item.kind!=='none'))return 'animation';
  return undefined;
}

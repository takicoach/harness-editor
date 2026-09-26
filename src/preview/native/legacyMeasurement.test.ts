/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import type { PlannedVisual } from '../../core/sequence/scenePlan';
import type { RenderedSceneGeometry } from './renderGeometry';
import { measureLegacyVisuals } from './legacyMeasurement';

afterEach(()=>{vi.restoreAllMocks();document.body.replaceChildren();});
it('measures visible legacy fragments in composition pixels and rejects another frame or document',()=>{
  const mount=document.createElement('div');document.body.append(mount);const root=mount.attachShadow({mode:'open'});
  root.innerHTML='<div data-native-clip="a"><span>A</span></div><div data-native-clip="b"><span>B</span></div><div data-native-clip="foreign"><span>unrelated</span></div>';
  vi.spyOn(mount,'getBoundingClientRect').mockReturnValue({left:20,top:40,width:320,height:180} as DOMRect);
  const leaves=root.querySelectorAll('span');
  vi.spyOn(leaves[0]!,'getBoundingClientRect').mockReturnValue({left:30,top:140,width:100,height:20} as DOMRect);
  vi.spyOn(leaves[1]!,'getBoundingClientRect').mockReturnValue({left:100,top:145,width:100,height:20} as DOMRect);
  const foreign=vi.spyOn(leaves[2]!,'getBoundingClientRect');
  const visuals=['a','b'].map(id=>({clip:{id,content:{kind:'telop',legacyId:7}}} as PlannedVisual));
  const geometry:RenderedSceneGeometry={documentId:'draft',revision:4,frame:20,resolution:{width:640,height:360},videos:[]};
  const request={documentId:'draft',revision:4,frame:20,kind:'telop' as const};
  expect(measureLegacyVisuals(root,mount,geometry,visuals,request)?.items).toEqual([{kind:'telop',id:7,rect:{x:20,y:200,w:340,h:50}}]);
  expect(foreign).not.toHaveBeenCalled();
  expect(measureLegacyVisuals(root,mount,geometry,visuals,{...request,frame:21})).toBeNull();
  expect(measureLegacyVisuals(root,mount,geometry,visuals,{...request,documentId:'other'})).toBeNull();
  expect(measureLegacyVisuals(root,mount,geometry,visuals,{...request,revision:5})).toBeNull();
  expect(measureLegacyVisuals(root,mount,geometry,visuals,{...request,id:8})?.items).toEqual([]);
});

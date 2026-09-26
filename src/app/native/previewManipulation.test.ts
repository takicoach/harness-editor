import {describe,expect,it} from 'vitest';
import {movePreviewPlacement,previewVideoCorners,resizePreviewVideo,type PreviewCorner,type PreviewPlacement,type PreviewPoint,type PreviewVideoGeometry} from './previewManipulation';

const corners:PreviewCorner[]=['nw','ne','se','sw'];
const opposite:Record<PreviewCorner,PreviewCorner>={nw:'se',ne:'sw',se:'nw',sw:'ne'};
const fixtures=[
  {name:'landscape half size',resolution:{width:1920,height:1080},viewport:{x:240,y:110,width:960,height:540},source:{displayWidth:1920,displayHeight:1080},fitted:[1920,1080]},
  {name:'4:3 contain',resolution:{width:1920,height:1080},viewport:{x:-120,y:37,width:640,height:360},source:{displayWidth:640,displayHeight:480},fitted:[1440,1080]},
  {name:'portrait quarter turn',resolution:{width:1080,height:1920},viewport:{x:181,y:-20,width:270,height:480},source:{displayWidth:1920,displayHeight:1080,rotation:90},fitted:[1920,1080]},
  {name:'270-degree source with nonuniform client size',resolution:{width:1920,height:1080},viewport:{x:30,y:75,width:800,height:500},source:{displayWidth:1080,displayHeight:1920,rotation:270},fitted:[1080,1920]},
  {name:'anamorphic source',resolution:{width:1920,height:1080},viewport:{x:90,y:160,width:384,height:216},source:{displayWidth:720,displayHeight:576,sampleAspectRatio:16/15,rotation:180},fitted:[1440,1080]},
];
type Fixture=typeof fixtures[number];
const initial:PreviewPlacement={x:.24,y:-.18,scale:.8,rotation:31,flipH:false,flipV:false};
const add=(a:PreviewPoint,b:PreviewPoint)=>({x:a.x+b.x,y:a.y+b.y});
const subtract=(a:PreviewPoint,b:PreviewPoint)=>({x:a.x-b.x,y:a.y-b.y});
const multiply=(a:PreviewPoint,k:number)=>({x:a.x*k,y:a.y*k});
const close=(a:PreviewPoint,b:PreviewPoint)=>{expect(a.x).toBeCloseTo(b.x,8);expect(a.y).toBeCloseTo(b.y,8);};

// Independent reconstruction: fixture fit sizes are hand-calculated, then each
// compositor vertex is transformed with affine matrices. No production helper
// or production fit/resize formula is used to construct the expected vertices.
function rendered(fixture:Fixture,placement:PreviewPlacement):Record<PreviewCorner,PreviewPoint>{
  type Matrix=[number,number,number,number,number,number];
  const apply=([a,b,c,d,e,f]:Matrix,p:PreviewPoint)=>({x:a*p.x+c*p.y+e,y:b*p.x+d*p.y+f});
  const angle=(placement.rotation-(fixture.source.rotation??0))*Math.PI/180;
  const rotate:Matrix=[Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),0,0];
  const translate:Matrix=[1,0,0,1,fixture.resolution.width*(.5+placement.x/2),fixture.resolution.height*(.5+placement.y/2)];
  const client:Matrix=[fixture.viewport.width/fixture.resolution.width,0,0,fixture.viewport.height/fixture.resolution.height,fixture.viewport.x,fixture.viewport.y];
  const vertices=[[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]];
  return Object.fromEntries(corners.map((corner,index)=>[corner,apply(client,apply(translate,apply(rotate,{
    x:vertices[index]![0]!*fixture.fitted[0]!*placement.scale,y:vertices[index]![1]!*fixture.fitted[1]!*placement.scale,
  })))])) as Record<PreviewCorner,PreviewPoint>;
}

describe('native video client geometry',()=>{
  it.each(fixtures)('matches compositor vertices: $name',fixture=>{
    const expected=rendered(fixture,initial),actual=previewVideoCorners(fixture,initial);
    corners.forEach(corner=>close(actual[corner],expected[corner]));
  });
  it.each(fixtures)('moves every rendered corner by the cursor displacement: $name',fixture=>{
    const delta={x:127.5,y:-33},placement={...initial,opacity:.4},next=movePreviewPlacement(placement,fixture.viewport,delta);
    const before=rendered(fixture,placement),after=rendered(fixture,next);
    corners.forEach(corner=>close(after[corner],add(before[corner],delta)));
    expect(next.rotation).toBe(placement.rotation);expect(next.opacity).toBe(.4);expect(next.scale).toBe(placement.scale);
    expect(movePreviewPlacement(placement,fixture.viewport,{x:0,y:0})).toBe(placement);
  });
});

describe('opposite-corner uniform resize',()=>{
  for(const fixture of fixtures)for(const corner of corners)for(const [flipH,flipV] of [[false,false],[false,true],[true,false],[true,true]] as const){
    it(`${fixture.name}, ${corner}, flip ${flipH}/${flipV}: follows diagonal and fixes opposite corner`,()=>{
      const placement={...initial,flipH,flipV},before=rendered(fixture,placement),diagonal=subtract(before[corner],before[opposite[corner]]);
      // Grab away from the exact corner: initial click must not cause a jump.
      const start=add(before[corner],{x:7,y:-3}),delta=multiply(diagonal,.4);
      const next=resizePreviewVideo(fixture,placement,corner,start,add(start,delta));expect(next).not.toBeNull();
      const after=rendered(fixture,next!);
      close(after[opposite[corner]],before[opposite[corner]]);close(after[corner],add(before[corner],delta));
      expect(next!.scale).toBeCloseTo(placement.scale*1.4,12);expect(next!.rotation).toBe(placement.rotation);
      expect(next!.flipH).toBe(flipH);expect(next!.flipV).toBe(flipV);
      expect(resizePreviewVideo(fixture,placement,corner,start,start)).toBe(placement);
      const actual=previewVideoCorners(fixture,next!);corners.forEach(key=>close(actual[key],after[key]));
    });
  }
  it.each(fixtures)('ignores perpendicular motion while following the diagonal component: $name',fixture=>{
    const before=rendered(fixture,initial),diagonal=subtract(before.se,before.nw),length=Math.hypot(diagonal.x,diagonal.y);
    const perpendicular={x:-diagonal.y/length*73,y:diagonal.x/length*73},along=multiply(diagonal,-.25);
    const next=resizePreviewVideo(fixture,initial,'se',before.se,add(before.se,add(along,perpendicular)))!;
    const after=rendered(fixture,next);close(after.nw,before.nw);close(after.se,add(before.se,along));
    expect(next.scale).toBeCloseTo(initial.scale*.75,12);
  });
  it('does not create negative scale or implicit flips when crossing the anchor',()=>{
    const fixture=fixtures[0]!,before=rendered(fixture,initial),diagonal=subtract(before.se,before.nw);
    expect(resizePreviewVideo(fixture,initial,'se',before.se,add(before.se,multiply(diagonal,-1.2)))).toBeNull();
  });
  it('rejects the exact opposite corner as zero size without a rounding sliver',()=>{
    const geometry:PreviewVideoGeometry={resolution:{width:100,height:100},viewport:{x:0,y:0,width:100,height:100},source:{displayWidth:100,displayHeight:100}};
    const placement={...initial,x:0,y:0,scale:1,rotation:0};
    expect(resizePreviewVideo(geometry,placement,'se',{x:100,y:100},{x:0,y:0})).toBeNull();
  });
  it('returns unclamped geometry so a caller cannot accidentally break the fixed corner',()=>{
    const fixture=fixtures[0]!,before=rendered(fixture,initial),diagonal=subtract(before.se,before.nw);
    const next=resizePreviewVideo(fixture,initial,'se',before.se,add(before.se,multiply(diagonal,20)))!;
    expect(next.scale).toBeGreaterThan(8);close(rendered(fixture,next).nw,before.nw);
  });
  it('rejects invalid geometry instead of returning NaN',()=>{
    const fixture=fixtures[0]!,invalid:PreviewVideoGeometry={...fixture,viewport:{...fixture.viewport,width:0}};
    expect(()=>previewVideoCorners(invalid,initial)).toThrow(RangeError);
    expect(()=>previewVideoCorners({...fixture,source:{...fixture.source,sampleAspectRatio:NaN}},initial)).toThrow(RangeError);
    expect(()=>movePreviewPlacement(initial,fixture.viewport,{x:Infinity,y:0})).toThrow(RangeError);
    expect(()=>resizePreviewVideo(fixture,{...initial,scale:0},'nw',{x:0,y:0},{x:1,y:1})).toThrow(RangeError);
  });
});

describe('offset DOM/SVG content with composition-center origin',()=>{
  const geometry:PreviewVideoGeometry={resolution:{width:640,height:360},viewport:{x:47,y:-18,width:800,height:360},
    source:{displayWidth:640,displayHeight:360},localBounds:{x:44,y:244,width:188,height:52}};
  // Independent reconstruction of every original content vertex through CSS
  // scale/flip, rotate, translate, then a nonuniform client-space mapping.
  const renderContent=(placement:PreviewPlacement)=>Object.fromEntries(corners.map((corner,index)=>{
    const vertex=[[44,244],[232,244],[232,296],[44,296]][index]!;
    const x=(vertex[0]!-320)*(placement.flipH?-1:1)*placement.scale,y=(vertex[1]!-180)*(placement.flipV?-1:1)*placement.scale;
    const angle=placement.rotation*Math.PI/180;
    return [corner,{x:47+(320+placement.x*320+Math.cos(angle)*x-Math.sin(angle)*y)*1.25,
      y:-18+180+placement.y*180+Math.sin(angle)*x+Math.cos(angle)*y}];
  })) as Record<PreviewCorner,PreviewPoint>;
  for(const corner of corners)for(const flipH of [false,true])for(const flipV of [false,true]){
    it(`${corner}, flip ${flipH}/${flipV}: tracks projected motion and keeps the offset opposite corner fixed`,()=>{
      const placement={...initial,flipH,flipV},before=renderContent(placement),actual=previewVideoCorners(geometry,placement);
      corners.forEach(key=>close(actual[key],before[key]));
      const diagonal=subtract(before[corner],before[opposite[corner]]),length=Math.hypot(diagonal.x,diagonal.y);
      const along=multiply(diagonal,-.2),perpendicular={x:-diagonal.y/length*29,y:diagonal.x/length*29};
      const start=add(before[corner],{x:4,y:-2});
      const next=resizePreviewVideo(geometry,placement,corner,start,add(start,add(along,perpendicular)))!;
      const after=renderContent(next);close(after[opposite[corner]],before[opposite[corner]]);close(after[corner],add(before[corner],along));
      expect(next.scale).toBeCloseTo(placement.scale*.8,12);expect(next.rotation).toBe(placement.rotation);
      expect(next.flipH).toBe(flipH);expect(next.flipV).toBe(flipV);
      expect(resizePreviewVideo(geometry,placement,corner,start,start)).toBe(placement);
      const moved=renderContent(movePreviewPlacement(placement,geometry.viewport,{x:21,y:-7}));
      corners.forEach(key=>close(moved[key],add(before[key],{x:21,y:-7})));
    });
  }
  it('rejects crossing the offset anchor without changing flip',()=>{
    const before=renderContent(initial),diagonal=subtract(before.se,before.nw);
    expect(resizePreviewVideo(geometry,initial,'se',before.se,add(before.se,multiply(diagonal,-1.1)))).toBeNull();
  });
});

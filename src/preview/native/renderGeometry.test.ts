import {describe,expect,it} from 'vitest';
import {fitDecodedVideo,fitDecodedImage,unplaceBorderBox,staticTextBorderSize,assertRenderableGraphicPosition,measurableGraphicBox} from './renderGeometry';

it('rejects CSS/pixel overflow rather than silently retaining a previous transform, and permits recovery',()=>{
  const resolution={width:640,height:360};
  for(const x of [1e3,1e6,1e30])expect(()=>assertRenderableGraphicPosition({x,y:-x},resolution)).not.toThrow();
  for(const x of [Number.MAX_VALUE,Number.MAX_VALUE/100,Infinity,NaN])expect(()=>assertRenderableGraphicPosition({x,y:0},resolution)).toThrow('プロパティ');
  expect(()=>assertRenderableGraphicPosition({x:0,y:0},resolution)).not.toThrow();
});
it('keeps a partially visible box measurable but omits offscreen and collapsed DOM boxes',()=>{
  const view={x:200,y:100,width:640,height:360};
  expect(measurableGraphicBox({x:180,y:110,width:100,height:40},view)).toBe(true);
  expect(measurableGraphicBox({x:3.2e8,y:110,width:64,height:64},view)).toBe(false);
  expect(measurableGraphicBox({x:3.2e32,y:110,width:0,height:0},view)).toBe(false);
});

describe('static inner text layout',()=>{
  it.each([.05,.6,1,8])('keeps the actual inner scale %s and bottom-origin translation before outer placement',scale=>{
    const raw={x:70,y:220,width:200,height:48},origin={x:320,y:360*(1-100/1080)},translation={x:24,y:-360*.5*(1-200/1080)};
    const innerCenter={x:origin.x+(raw.x+raw.width/2-origin.x)*scale+translation.x,
      y:origin.y+(raw.y+raw.height/2-origin.y)*scale+translation.y};
    const outer={x:.2,y:-.1,scale:.7,rotation:31,flipH:true,flipV:false,opacity:1};
    const dx=-(innerCenter.x-320)*.7,dy=(innerCenter.y-180)*.7,angle=31*Math.PI/180;
    const measuredCenter={x:384+dx*Math.cos(angle)-dy*Math.sin(angle),y:162+dx*Math.sin(angle)+dy*Math.cos(angle)};
    const size=staticTextBorderSize(raw,{is2D:true,a:scale,b:0,c:0,d:scale})!;
    const box=unplaceBorderBox(measuredCenter,size,{width:640,height:360},outer)!;
    expect(box.x).toBeCloseTo(origin.x+(raw.x-origin.x)*scale+translation.x,10);
    expect(box.y).toBeCloseTo(origin.y+(raw.y-origin.y)*scale+translation.y,10);
    expect(box.width).toBeCloseTo(200*scale,12);expect(box.height).toBeCloseTo(48*scale,12);
  });
  it.each([
    {is2D:true,a:1,b:.1,c:0,d:1},{is2D:true,a:1,b:0,c:0,d:2},
    {is2D:true,a:-1,b:0,c:0,d:-1},{is2D:false,a:1,b:0,c:0,d:1},
  ])('omits an unsupported inner matrix %j',matrix=>{
    expect(staticTextBorderSize({width:200,height:48},matrix)).toBeUndefined();
  });
});

describe('measured content before outer placement',()=>{
  for(const rotation of [0,31,90,137])for(const flipH of [false,true])for(const flipV of [false,true]){
    it(`recovers the offset border box from AABB center, rotation ${rotation}, flip ${flipH}/${flipV}`,()=>{
      const box={x:37.125,y:221.75,width:182.5,height:45.125},resolution={width:640,height:360};
      const transform={x:.23,y:-.12,scale:.65,rotation,flipH,flipV,opacity:1};
      // Independent forward CSS transform of all four vertices, then DOM AABB.
      const vertices=[[box.x,box.y],[box.x+box.width,box.y],[box.x+box.width,box.y+box.height],[box.x,box.y+box.height]].map(([x,y])=>{
        const u=(x!-320)*(flipH?-.65:.65),v=(y!-180)*(flipV?-.65:.65),angle=rotation*Math.PI/180;
        return {x:320+.23*320+u*Math.cos(angle)-v*Math.sin(angle),y:180-.12*180+u*Math.sin(angle)+v*Math.cos(angle)};
      });
      const left=Math.min(...vertices.map(p=>p.x)),right=Math.max(...vertices.map(p=>p.x));
      const top=Math.min(...vertices.map(p=>p.y)),bottom=Math.max(...vertices.map(p=>p.y));
      const actual=unplaceBorderBox({x:(left+right)/2,y:(top+bottom)/2},box,resolution,transform)!;
      expect(actual.x).toBeCloseTo(box.x,10);expect(actual.y).toBeCloseTo(box.y,10);
      expect(actual.width).toBe(box.width);expect(actual.height).toBe(box.height);
      // Rotated AABB dimensions would produce the wrong content rectangle.
      if(rotation===31)expect((right-left)/transform.scale).not.toBeCloseTo(box.width,2);
    });
  }
  it.each([{width:0,height:16},{width:32,height:0}])('omits an empty border box %j without failing the frame',size=>{
    expect(unplaceBorderBox({x:20,y:200},size,{width:640,height:360},{x:0,y:0,scale:1,rotation:0,flipH:false,flipV:false,opacity:1})).toBeUndefined();
  });
});

// Real Chromium H.264 SAR 16:15 probe: coded 720x578, visible 720x576,
// display 768x576. Display dimensions already contain the SAR correction.
const decoded=(displayWidth:number,displayHeight:number,width:number,height:number)=>({
  displayWidth,displayHeight,
  visibleRect:{x:0,y:0,width,height,top:0,left:0,right:width,bottom:height,toJSON:()=>({})},
});

describe('decoded image contain geometry',()=>{
  it.each([
    [{width:200,height:100},{width:320,height:160}],
    [{width:100,height:200},{width:90,height:180}],
    [{width:2,height:1},{width:320,height:160}],
    [{width:100,height:100},{width:180,height:180}],
  ])('fits the entire oriented bitmap %j, including transparent margins', (natural,expected)=>{
    expect(fitDecodedImage(natural,{width:320,height:180},1)).toEqual(expected);
    expect(fitDecodedImage(natural,{width:160,height:90},.5)).toEqual(expected);
  });
  it('uses the measured CSS box, retaining fractional layout dimensions',()=>{
    const fitted=fitDecodedImage({width:300,height:100},{width:123.5,height:70.25},.4);
    expect(fitted.width*.4).toBeCloseTo(123.5,12);
    expect(fitted.height*.4).toBeCloseTo(123.5/3,12);
  });
  it('does not publish geometry before a bitmap has decoded',()=>{
    expect(()=>fitDecodedImage({width:0,height:0},{width:320,height:180},1)).toThrow('画像の表示領域');
  });
});
describe('decoded video contain geometry',()=>{
  it.each([768,720])('applies SAR once regardless of decoder display width %i',displayWidth=>{
    expect(fitDecodedVideo(decoded(displayWidth,576,720,576),16/15,0,{width:720,height:576}))
      .toEqual({width:720,height:540});
  });
  it.each([90,-90,270])('applies SAR before source quarter-turn %i',rotation=>{
    const fit=fitDecodedVideo(decoded(768,576,720,576),16/15,rotation,{width:720,height:576});
    expect(fit).toEqual({width:576,height:432});
    // After rotation the physical bounding rectangle is 432x576 (3:4).
    expect(fit.height/fit.width).toBe(3/4);
  });
  it('uses the cropped pixel region without coded padding or display scaling',()=>{
    expect(fitDecodedVideo(decoded(1920,1080,704,576),12/11,0,{width:800,height:600}))
      .toEqual({width:800,height:600});
  });
  it('keeps square pixels and source half-turn unchanged',()=>{
    expect(fitDecodedVideo(decoded(640,360,640,360),1,180,{width:720,height:576}))
      .toEqual({width:720,height:405});
  });
  it('rejects a closed frame instead of guessing from display dimensions',()=>{
    expect(()=>fitDecodedVideo({displayWidth:0,displayHeight:0,visibleRect:null},1,0,{width:720,height:576}))
      .toThrow('映像の表示領域を取得できません');
  });
});

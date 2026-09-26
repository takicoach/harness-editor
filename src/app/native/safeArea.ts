/** OSS `PreviewOverlay.tsx:993-1013` と同じ比率。戻り値は合成面に対する割合（0..1）。 */
export function safeAreaBoxes(resolution:{width:number;height:number}):{safe:{left:number;top:number;width:number;height:number};band:{left:number;top:number;width:number;height:number}|null}{
  const portrait=resolution.height>resolution.width;
  return {safe:{left:.05,top:.05,width:.9,height:.9},band:portrait?{left:0,top:.82,width:1,height:.18}:null};
}

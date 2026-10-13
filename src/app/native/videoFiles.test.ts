import {expect,it} from 'vitest';
import {splitVideoFiles} from './videoFiles';
it('splits videos in natural name order from the other files',()=>{
  const files=['clip10.mp4','theme.mp3','clip2.MOV','still.png','0727.mp4'].map(name=>new File(['x'],name));
  const {videos,others}=splitVideoFiles(files);
  expect(videos.map(f=>f.name)).toEqual(['0727.mp4','clip2.MOV','clip10.mp4']);expect(others.map(f=>f.name)).toEqual(['theme.mp3','still.png']);
});

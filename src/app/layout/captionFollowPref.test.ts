/** @vitest-environment jsdom */
import {afterEach,expect,it} from 'vitest';
import {loadCaptionFollow,saveCaptionFollow} from './captionFollowPref';

afterEach(()=>localStorage.clear());
it('defaults to following playback',()=>{expect(loadCaptionFollow()).toBe(true);});
it('round-trips both values under its own key',()=>{
  saveCaptionFollow(false);expect(localStorage.getItem('sme.native.caption-follow')).toBe('0');expect(loadCaptionFollow()).toBe(false);
  saveCaptionFollow(true);expect(loadCaptionFollow()).toBe(true);
});
it('ignores a corrupt value instead of throwing',()=>{
  localStorage.setItem('sme.native.caption-follow','{');expect(loadCaptionFollow()).toBe(true);
});

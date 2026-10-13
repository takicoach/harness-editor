// src/server/sequence/media.pinned.test.ts
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {copyFileSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {pinnedSequenceAsset,probePinnedSequenceAsset,probeSequenceAssetSource} from './media';
import {makeMediaSamples,type MediaSamples} from './__fixtures__/mediaSamples';
import {makeVideoSamples,type VideoSamples} from './__fixtures__/videoSamples';

/**
 * パスで調べる経路（コピー取り込み・移行）と、開いた実体で調べる経路（参照取り込み）は、同じファイルから
 * 同じ素材（id・kind・streams）・同じ付帯情報（表紙の番号・画像の寸法）・同じ失敗を返す。共通化の前後で変えない。
 */
let media:MediaSamples,video:VideoSamples,root:string;
beforeAll(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'media-pinned-')));
  mkdirSync(join(root,'media'));mkdirSync(join(root,'video'));media=makeMediaSamples(join(root,'media'));video=makeVideoSamples(join(root,'video'));
  copyFileSync(media.wav,join(root,'sound-only.png'));writeFileSync(join(root,'subtitles.mkv'),'1\n00:00:00,000 --> 00:00:01,000\nこんにちは\n');},60000);
afterAll(()=>rmSync(root,{recursive:true,force:true}));
async function pinned(path:string){const handle=await open(path,'r');try{return await probePinnedSequenceAsset(handle,basename(path));}finally{await handle.close();}}

describe('パスでの調査と開いた実体での調査が同じ結果になる',()=>{
  it.each([['動画と音声','first'],['回転付きの動画','rotated'],['音声なしの動画','silent']] as const)('%s',async(_,key)=>{
    const path=video[key],source=await probeSequenceAssetSource(path,basename(path),'名前'),probed=await pinned(path);
    expect(pinnedSequenceAsset(probed,source.asset.fingerprint,basename(path),'名前')).toStrictEqual(source.asset);
    expect(probed).toStrictEqual({kind:'media',streams:source.asset.streams,attachedPictureIndexes:source.attachedPictureIndexes});
    expect(source).not.toHaveProperty('image');
  });
  it.each(['wav','coverMp3','coverM4a'] as const)('音声 %s（表紙の番号も同じ）',async key=>{
    const path=media[key],source=await probeSequenceAssetSource(path,basename(path),'名前'),probed=await pinned(path);
    expect(pinnedSequenceAsset(probed,source.asset.fingerprint,basename(path),'名前')).toStrictEqual(source.asset);
    expect(probed.attachedPictureIndexes).toStrictEqual(source.attachedPictureIndexes);expect(probed).not.toHaveProperty('image');
  });
  it.each(['landscapePng','exifRotatedJpg','animatedGif','stillGif'] as const)('画像 %s（寸法・向き・コマ数も同じ）',async key=>{
    const path=media[key],source=await probeSequenceAssetSource(path,basename(path),'名前'),probed=await pinned(path);
    expect(pinnedSequenceAsset(probed,source.asset.fingerprint,basename(path),'名前')).toStrictEqual(source.asset);
    expect(source.asset).toMatchObject({kind:'image',streams:[]});expect(source.attachedPictureIndexes).toStrictEqual([]);
    expect(probed).toStrictEqual({kind:'image',streams:[],attachedPictureIndexes:[],image:source.image});expect(source.image).toBeDefined();
  });
  it.each([['中身が文字列の画像',()=>media.brokenPng],['音声だけの画像',()=>join(root,'sound-only.png')]])('%s はどちらも「画像を読み取れません」',async(_,at)=>{
    const path=at();
    await expect(probeSequenceAssetSource(path,basename(path),'名前')).rejects.toThrow('画像を読み取れません');
    await expect(pinned(path)).rejects.toThrow('画像を読み取れません');
  });
  it('映像も音声もない素材はどちらも断る',async()=>{
    const path=join(root,'subtitles.mkv');
    await expect(probeSequenceAssetSource(path,basename(path),'名前')).rejects.toThrow('映像または音声のストリームがありません');
    await expect(pinned(path)).rejects.toThrow('映像または音声のストリームがありません');
  });
  it('中身が動画でないファイルはどちらも準備の失敗として断る',async()=>{
    await expect(probeSequenceAssetSource(video.broken,'broken.mp4','名前')).rejects.toThrow('素材の準備に失敗しました');
    await expect(pinned(video.broken)).rejects.toThrow('素材の準備に失敗しました');
  });
});

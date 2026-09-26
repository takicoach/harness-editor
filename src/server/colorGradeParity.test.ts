/**
 * カラー補正の数式パリティ（F-2）。
 *
 * エディタ側の正典 `src/core/colorGrade.ts` と、案件へコピーされる自己完結の複製
 * `src/server/mainLayoutPayload/colorGrade.ts` が、**同じ入力から同じ行列文字列**を出すことを
 * 全数走査で固定する。片方だけ直すと（係数・適用順・丸め桁のいずれでも）ここが赤くなる。
 *
 * motionKeyframeParity.test.ts と同じ役割の計器。
 */
import { describe, it, expect } from 'vitest';
import * as core from '../core/colorGrade';
import * as payload from './mainLayoutPayload/colorGrade';

/** 端・中間・非対称を含む走査点。4 パラメータの直積で 6^4 = 1296 通り。 */
const VALUES = [-100, -73, -1, 0, 37, 100];

describe('colorGrade — core と payload の数式が一致する', () => {
  it('1296 通りすべてで行列文字列が一致する', () => {
    let checked = 0;
    let nonIdentity = 0;
    for (const brightness of VALUES) {
      for (const contrast of VALUES) {
        for (const saturation of VALUES) {
          for (const temperature of VALUES) {
            const g = { brightness, contrast, saturation, temperature };
            const a = core.colorGradeMatrixValues(g);
            const b = payload.colorGradeMatrixValues(g);
            expect(b, `不一致: ${JSON.stringify(g)}`).toBe(a);
            expect(payload.isIdentityColorGrade(g)).toBe(core.isIdentityColorGrade(g));
            if (!core.isIdentityColorGrade(g)) nonIdentity++;
            checked++;
          }
        }
      }
    }
    // 走査が空でない・恒等ばかりでないことの存在検査（比較器が無感になっていないか）。
    expect(checked).toBe(VALUES.length ** 4);
    expect(nonIdentity).toBeGreaterThan(1000);
  });

  it('id と既定値も一致する', () => {
    expect(payload.DEFAULT_COLOR_GRADE).toEqual(core.DEFAULT_COLOR_GRADE);
  });

  it('filter id は scope ごとに一致し、メインとサブで別 id', () => {
    expect(payload.colorGradeFilterId('main')).toBe(core.colorGradeFilterId('main'));
    expect(payload.colorGradeFilterId('insert')).toBe(core.colorGradeFilterId('insert'));
    expect(core.colorGradeFilterId('main')).not.toBe(core.colorGradeFilterId('insert'));
  });

  it('CPU モデル（画素突合用）も一致する', () => {
    const g = { brightness: 22, contrast: -41, saturation: 63, temperature: -18 };
    for (const px of [[0, 0, 0], [255, 255, 255], [200, 90, 40], [17, 233, 128]] as const) {
      expect(payload.applyColorGrade8(g, px)).toEqual(core.applyColorGrade8(g, px));
    }
  });

  it('複製は src/core を import しない（案件が単体で render できる条件）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('./mainLayoutPayload/colorGrade.ts', import.meta.url),
      'utf8',
    );
    expect(/^\s*import\s/m.test(src)).toBe(false);
  });
});

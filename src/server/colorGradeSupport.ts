/**
 * colorGradeSupport — 案件がカラー補正（F-2）を書き出しへ反映できるかの判定。
 *
 * 判定は **fail-closed**（2 つ揃って初めて true）:
 *   1. `src/MainLayout/colorGrade.ts` が目印（COLOR_GRADE_V1）を持つ … 色を計算する部品がある
 *   2. `src/MainVideo.tsx` が `colorGrade=` を持つ … その部品へ値が渡っている
 * どちらか一方でも欠けると書き出しに出ない。install（installMainLayout）は 2 つを
 * 同時に書くので、片方だけ真になるのは「手で戻した」「旧版」のときだけ——
 * そのときは注意書きを出したい側なので、片方だけでは true にしない。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { COLOR_GRADE_MARKER } from '../shared/colorGradeSupport';
import { readNativeDataPackState } from './nativeDataPacks';
import { parseVideoConfigStatic } from '../core/videoConfig';

export { COLOR_GRADE_MARKER } from '../shared/colorGradeSupport';
export { isVideoInsertColorGradeWired } from '../shared/colorGradeSupport';

function readIfExists(dir: string, rel: string): string | null {
  const path = join(dir, rel);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 色を計算する部品（MainLayout パックの colorGrade.ts）が目印つきで置かれているか。 */
export function hasColorGradePayload(dir: string): boolean {
  const payload = readIfExists(dir, join('src', 'MainLayout', 'colorGrade.ts'));
  return payload !== null && payload.includes(COLOR_GRADE_MARKER);
}

/**
 * 案件ディレクトリを見て、カラー補正が書き出しへ反映されるかを返す。
 * サブ動画が導入済みなのにサブ動画側が包まれていない案件も **false**（＝注意書きを出す）。
 * メインだけ補正が乗った絵（彩度 -100 でメインだけ白黒）は「黙って食い違う」ため。
 */
export function detectColorGradeSupport(dir: string): boolean {
  if (hasNativeColorGradeSupport(dir)) return true;
  if (!hasColorGradePayload(dir)) return false;
  const mainVideo = readIfExists(dir, join('src', 'MainVideo.tsx'));
  if (mainVideo === null) return false;
  return hasRenderedColorGradeWiring(mainVideo);
}

/** Inspect actual JSX. Documentation examples must neither enable support nor
 * make a correctly installed pack appear unsupported. */
function hasRenderedColorGradeWiring(source: string): boolean {
  const file = ts.createSourceFile('MainVideo.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let main = false, valid = true;
  const expression = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, key: string, identifier: string) =>
    node.attributes.properties.some(a => ts.isJsxAttribute(a) && a.name.getText(file) === key &&
      a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression &&
      ts.isIdentifier(a.initializer.expression) && a.initializer.expression.text === identifier);
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(file);
      if (name === 'MainLayout') {
        main = true;
        if (!expression(node, 'colorGrade', 'COLOR_GRADE')) valid = false;
      }
      if (name === 'VideoInsertSequence') {
        let wrapped = false, wrappers = 0;
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (!ts.isJsxElement(parent)) continue;
          const opening = parent.openingElement;
          if (opening.tagName.getText(file) === 'MainLayout') valid = false;
          if (opening.tagName.getText(file) === 'ColorGradeLayer') {
            wrappers++;
            wrapped = expression(opening, 'grade', 'COLOR_GRADE') && opening.attributes.properties.some(a =>
              ts.isJsxAttribute(a) && a.name.getText(file) === 'scope' && a.initializer &&
              ts.isStringLiteral(a.initializer) && a.initializer.text === 'insert');
          }
        }
        if (!wrapped || wrappers !== 1) valid = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return main && valid;
}

/** Old scalar-only packs must be upgraded before accepting wheel edits. */
export function detectColorWheelsSupport(dir: string): boolean {
  if (hasNativeColorGradeSupport(dir)) return true;
  if (!detectColorGradeSupport(dir)) return false;
  const math = readIfExists(dir, join('src', 'MainLayout', 'colorGrade.ts'));
  const layer = readIfExists(dir, join('src', 'MainLayout', 'MainLayout.tsx'));
  const canonical = join(import.meta.dirname, 'mainLayoutPayload');
  // These two self-contained files are installed verbatim. Match the actual
  // pack, not tokens that can appear in comments or a disconnected JSX branch.
  // A customized/partial pack can retain the old scalar capability, but must
  // be updated before enabling this new feature.
  return math !== null && layer !== null && math.includes('COLOR_WHEELS_V1') &&
    math === readIfExists(canonical, 'colorGrade.ts') &&
    layer === readIfExists(canonical, 'MainLayout.tsx');
}

/** Native rendering owns the grade matrix/wheels for both main and inserted
 * video. This certifies the data feature, not custom legacy JSX equivalence. */
function hasNativeColorGradeSupport(dir:string):boolean {
  if (readNativeDataPackState('mainLayout',dir).status !== 'ready') return false;
  try {
    const source=readIfExists(dir,'src/videoConfig.ts');if(source===null)return false;
    const config=parseVideoConfigStatic(source);
    return [config.fps,config.durationFrames,config.resolution.width,config.resolution.height]
      .every(value=>Number.isFinite(value)&&value>0);
  } catch {return false;}
}

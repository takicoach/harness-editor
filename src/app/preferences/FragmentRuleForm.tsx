import {useState} from 'react';
import {fragmentReplacementSchema, replacePreferenceFragment, type FragmentReplacement} from '../../learning/preferenceRules';

export function FragmentRuleForm({before, after, disabled, onCreate, onCancel}: {
  before: string; after: string; disabled: boolean;
  onCreate: (replacement: FragmentReplacement) => void; onCancel: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [excluded, setExcluded] = useState('');
  const parsed = fragmentReplacementSchema.safeParse({from, to,
    exceptTextIncludes: excluded.split('\n').map((line) => line.trim()).filter(Boolean)});
  const preview = parsed.success ? replacePreferenceFragment(before, parsed.data) : null;
  const matches = preview !== null && preview === after;
  return <form className="preference-fragment-form" aria-label="語句のルール候補" onSubmit={(event) => {
    event.preventDefault();
    if (!disabled && matches && parsed.success) onCreate(parsed.data);
  }}>
    <h4>語句の表記をそろえる</h4>
    <p>この実例の修正を再現する語句を指定します。字幕の中にある同じ語句をすべて置換します。</p>
    <div className="preference-fragment-fields"><label>置換前の語句<input value={from} maxLength={10000} disabled={disabled} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>置換後の語句<input value={to} maxLength={10000} disabled={disabled} onChange={(e) => setTo(e.target.value)} /></label></div>
    <label>使わない字幕の目印（1行に1つ）<textarea value={excluded} disabled={disabled} onChange={(e) => setExcluded(e.target.value)} placeholder={'引用：\n商品名は'} /></label>
    <p>目印を含む字幕では提案しません。引用や商品名を自動で見分ける機能ではありません。</p>
    <p>実例の変更前：{before}</p><p>採用した本文：{after}</p>
    <p aria-live="polite">{matches ? `この条件で再現できます：${preview}` : from && to
      ? 'この条件では採用した本文を再現できません。語句と目印を確認してください。' : '置換前と置換後の語句を入力してください。'}</p>
    <div className="preference-actions"><button type="submit" disabled={disabled || !matches}>語句の候補を保存</button>
      <button type="button" disabled={disabled} onClick={onCancel}>やめる</button></div>
    <small>候補を保存しただけでは、字幕の変更やルールの有効化は行いません。</small>
  </form>;
}

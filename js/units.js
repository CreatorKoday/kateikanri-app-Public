// ==========================================================
// 商品名から単位(個・本・パックなど)を自動判定する
// ==========================================================

import { escapeHtml } from "./utils.js";

export const UNIT_RULES = [
  { keywords: ["卵", "たまご"], units: ["パック", "個"] },
  { keywords: ["牛乳", "豆乳"], units: ["本", "ml"] },
  { keywords: ["ヨーグルト", "チーズ", "納豆", "豆腐"], units: ["個", "パック"] },
  { keywords: ["米", "お米"], units: ["kg", "袋"] },
  { keywords: ["パン", "食パン"], units: ["斤", "袋"] },
  { keywords: ["肉", "鶏", "豚", "牛肉", "ひき肉", "ベーコン"], units: ["パック", "g"] },
  { keywords: ["魚", "鮭", "サーモン", "マグロ", "刺身"], units: ["パック", "切れ"] },
  { keywords: ["キャベツ", "レタス", "白菜"], units: ["個", "玉"] },
  { keywords: ["トマト", "きゅうり", "なす", "ピーマン", "にんじん", "人参", "じゃがいも", "玉ねぎ", "たまねぎ"], units: ["個"] },
  { keywords: ["水", "ミネラルウォーター"], units: ["本", "L"] },
  { keywords: ["ジュース", "お茶", "紅茶", "コーヒー", "炭酸", "ビール", "酒"], units: ["本"] },
  { keywords: ["醤油", "しょうゆ", "みりん", "油", "ソース", "ケチャップ", "マヨネーズ", "だし"], units: ["本"] },
  { keywords: ["味噌", "みそ"], units: ["個"] },
  { keywords: ["塩", "砂糖"], units: ["袋"] },
  { keywords: ["ティッシュ"], units: ["箱"] },
  { keywords: ["トイレットペーパー"], units: ["ロール", "パック"] },
  { keywords: ["洗剤", "柔軟剤", "漂白剤"], units: ["本"] },
  { keywords: ["歯ブラシ"], units: ["本"] },
  { keywords: ["マスク"], units: ["箱", "枚"] }
];

// 商品名から単位の候補を返す(1件なら確実、複数なら選ばせる)
export function guessUnitOptions(name) {
  const target = name || "";
  for (const rule of UNIT_RULES) {
    if (rule.keywords.some(k => target.includes(k))) return rule.units;
  }
  return ["個"];
}

// 単位チップ(候補ボタン群)を描画し、クリックでunitInputへ反映する共通処理
function renderUnitChips(units, unitInput, suggestBox) {
  suggestBox.innerHTML = units.map(u =>
    `<button type="button" class="unit-chip ${u === unitInput.value ? "selected" : ""}" data-unit="${escapeHtml(u)}">${escapeHtml(u)}</button>`
  ).join("");
  suggestBox.querySelectorAll(".unit-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      unitInput.value = chip.dataset.unit;
      suggestBox.querySelectorAll(".unit-chip").forEach(c => c.classList.remove("selected"));
      chip.classList.add("selected");
      unitInput.dispatchEvent(new Event("input"));
    });
  });
}

// 商品名 → 単位の自動提案(共通ロジック)。手動登録以外の画面(買い物リストからの
// 在庫登録など)でも同じ挙動を再利用できるよう、対象の要素を引数で受け取る。
// 単位が変わったら unitInput に "input" イベントを発火するので、呼び出し側は
// 通常の input リスナー(数量モード切替など)をそのまま使える。
export function applyUnitSuggestions({ nameInput, unitInput, suggestBox }) {
  const name = nameInput.value.trim();

  if (!name) {
    suggestBox.innerHTML = "";
    return;
  }

  const options = guessUnitOptions(name);

  if (options.length === 1) {
    // 単位が確実な場合: 自動入力しつつ、個数・重さ・容量への切り替えは
    // 常に選べるようにしておく
    unitInput.value = options[0];
    renderUnitChips(["個", "g", "ml"], unitInput, suggestBox);
  } else {
    // 複数の可能性がある場合: 候補をボタンで表示して選ばせる
    if (!options.includes(unitInput.value)) {
      unitInput.value = options[0];
    }
    renderUnitChips(options, unitInput, suggestBox);
  }
  unitInput.dispatchEvent(new Event("input"));
}

// ホーム画面(手動登録)向けの薄いラッパー。
// 商品名が未入力の間は共通ロジック(applyUnitSuggestions)が何も表示しない仕様だが、
// 右隣の数量・消費期限欄には常時表示のクイック調整ボタンがあり見た目のバランスが崩れるため、
// このラッパーだけ未入力時も既定の「個」「g」「ml」チップを表示する
// (unitInput.valueは書き換えない。ユーザーが単位を手入力済みの場合に上書きしないため)
export function updateUnitSuggestions() {
  const nameInput = document.getElementById("item-name");
  const unitInput = document.getElementById("item-unit");
  const suggestBox = document.getElementById("item-unit-suggestions");

  if (!nameInput.value.trim()) {
    renderUnitChips(["個", "g", "ml"], unitInput, suggestBox);
    return;
  }

  applyUnitSuggestions({ nameInput, unitInput, suggestBox });
}

document.getElementById("item-name").addEventListener("input", updateUnitSuggestions);
document.getElementById("item-name").addEventListener("blur", updateUnitSuggestions);

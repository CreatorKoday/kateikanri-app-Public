// ==========================================================
// 在庫(商品)の登録・一覧表示・ロット単位の数量操作
//
// items = 商品(名前・分類・単位・最低数量・product_master_idなど)
// item_lots = 在庫ロット(数量・賞味期限・購入日)。1商品に複数持てる
// product_master = 商品マスタ(標準商品名・カテゴリー・サブカテゴリーなど)
//
// 在庫一覧は、product_master_id が同じ商品(items)を「標準商品名」の
// 1カードにまとめ、その下に実際の商品名(items.name)ごとの区画を並べる。
// カテゴリー/サブカテゴリーの見出しは product_master.category / sub_category を
// 優先し、商品マスタが無い商品だけ items.category をフォールバックに使う。
// ==========================================================

import { supabaseClient } from "./config.js";
import { itemListEl, manualAddMessageBox } from "./elements.js";
import { showMessage, escapeHtml, showAppNotice, productMasterStatusPrefix } from "./utils.js";
import { syncShoppingListForItem, addToShoppingList, loadShoppingList } from "./shopping.js";
import { isContinuousUnit, computeCombinedStockQuantity, representativeUnitForEntries } from "./quantity.js";
import { openQuantityPicker } from "./quantityPicker.js";
import { resolveProductMaster, computeItemSearchScore, normalizeProductName } from "./productMaster.js";
import { updateUnitSuggestions } from "./units.js";

// 手動登録画面の数量欄(4桁ドラムロールピッカーで選択した値を保持する)
let manualQuantityValue = 1;
// ユーザーがまだ数量を一度も手動調整していない(初期値のままの)状態かどうか。
// touchedになる前は、単位の変更に合わせて初期値(個数系=1/定量系=100)を自動追従させる
let manualQuantityTouched = false;
const manualQuantityDisplay = document.getElementById("item-quantity-display");

function renderManualQuantityDisplay() {
  manualQuantityDisplay.querySelector(".qty-picker-trigger-value").textContent = manualQuantityValue;
}

function manualQuantityStep() {
  return isContinuousUnit(document.getElementById("item-unit").value.trim()) ? 100 : 1;
}

// 単位が変わるたびに呼ぶ。まだ手動調整されていなければ、単位に応じた初期値へ追従させる
function applyManualQuantityDefault() {
  if (manualQuantityTouched) return;
  manualQuantityValue = manualQuantityStep();
  renderManualQuantityDisplay();
}

manualQuantityDisplay.addEventListener("click", () => {
  openQuantityPicker({
    initialValue: manualQuantityValue,
    unit: document.getElementById("item-unit").value.trim(),
    title: "数量を選択",
    onConfirm: (value) => {
      manualQuantityValue = value;
      manualQuantityTouched = true;
      renderManualQuantityDisplay();
    }
  });
});

// 数量欄の下の[-1/+1]系クイック増減。在庫画面の[-][+]と同じく、単位が個数系か
// 定量系(g/mlなど)かで増減幅を変える
const manualQuantityQuickMinusBtn = document.getElementById("item-quantity-quick-minus");
const manualQuantityQuickPlusBtn = document.getElementById("item-quantity-quick-plus");

function renderManualQuantityQuickAdjustLabels() {
  const step = manualQuantityStep();
  manualQuantityQuickMinusBtn.textContent = `－${step}`;
  manualQuantityQuickPlusBtn.textContent = `＋${step}`;
}

document.getElementById("item-unit").addEventListener("input", () => {
  renderManualQuantityQuickAdjustLabels();
  applyManualQuantityDefault();
  updatePriceModeLabels();
});
renderManualQuantityQuickAdjustLabels();

// ---------- 価格入力の「1つ当たり/合計金額」切替 ----------
// 個数系の単位は[1つ当たり|合計金額]、定量系(g/ml等)は[100◯当たり|購入金額]の2択。
// 登録時、「1つ当たり/100◯当たり」はそのまま単価として保存し、「合計金額/購入金額」は
// 数量で割って単価に変換してから保存する(item_lots.priceは常に「1つ当たりの単価」を表す)
let priceMode = "total";
const priceModeToggleEl = document.getElementById("item-price-mode-toggle");
const priceModeUnitBtn = document.getElementById("item-price-mode-unit-btn");
const priceModeTotalBtn = document.getElementById("item-price-mode-total-btn");

function updatePriceModeLabels() {
  const unit = document.getElementById("item-unit").value.trim();
  const continuous = isContinuousUnit(unit);
  priceModeUnitBtn.textContent = continuous ? `100${unit}当たり` : "1つ当たり";
  priceModeTotalBtn.textContent = continuous ? "購入金額" : "合計金額";
}

function setPriceMode(mode) {
  priceMode = mode;
  priceModeToggleEl.dataset.mode = mode;
  priceModeUnitBtn.classList.toggle("active", mode === "unit");
  priceModeTotalBtn.classList.toggle("active", mode === "total");
}

priceModeUnitBtn.addEventListener("click", () => {
  priceManuallyEdited = true;
  setPriceMode("unit");
});
priceModeTotalBtn.addEventListener("click", () => {
  priceManuallyEdited = true;
  setPriceMode("total");
});

// 価格欄の入力値(価格モードに応じた表示上の値)を、item_lots.priceに保存する
// 「1つ当たりの単価」に変換する。数量が無い(0以下)場合や未入力の場合はnull
function computeStoredUnitPrice(inputValue, mode, unit, quantity) {
  if (inputValue === "" || inputValue === null || inputValue === undefined) return null;
  const value = Number(inputValue);
  if (Number.isNaN(value)) return null;
  if (mode === "unit") return value;

  const qty = Number(quantity) || 0;
  if (qty <= 0) return null;
  return isContinuousUnit(unit) ? Math.round((value * 100) / qty) : Math.round(value / qty);
}

manualQuantityQuickMinusBtn.addEventListener("click", () => {
  manualQuantityValue = Math.max(0, manualQuantityValue - manualQuantityStep());
  manualQuantityTouched = true;
  renderManualQuantityDisplay();
});
manualQuantityQuickPlusBtn.addEventListener("click", () => {
  manualQuantityValue = Math.min(9999, manualQuantityValue + manualQuantityStep());
  manualQuantityTouched = true;
  renderManualQuantityDisplay();
});

// 消費・賞味期限欄の下の[-1日/+1日]クイック調整。未入力の場合は今日を基準に加減する
function adjustManualExpiryByDays(delta) {
  const expiryInput = document.getElementById("item-expiry");
  const base = expiryInput.value ? new Date(expiryInput.value + "T00:00:00") : new Date();
  base.setDate(base.getDate() + delta);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, "0");
  const d = String(base.getDate()).padStart(2, "0");
  expiryInput.value = `${y}-${m}-${d}`;
}

document.getElementById("item-expiry-quick-minus").addEventListener("click", () => adjustManualExpiryByDays(-1));
document.getElementById("item-expiry-quick-plus").addEventListener("click", () => adjustManualExpiryByDays(1));

// 手動登録フォームの入力欄を初期状態へ戻す(登録成功時・×での閉じるボタンの両方から呼ばれる)
export function resetManualRegisterForm() {
  document.getElementById("item-name").value = "";
  document.getElementById("item-unit").value = "個";
  document.getElementById("item-unit-suggestions").innerHTML = "";
  renderManualQuantityQuickAdjustLabels();
  manualQuantityValue = 1;
  manualQuantityTouched = false;
  renderManualQuantityDisplay();
  document.getElementById("item-expiry").value = "";
  document.getElementById("item-type-fallback").classList.add("hidden");
  document.getElementById("item-price").value = "";
  priceManuallyEdited = false;
  setPriceMode("total");
  updatePriceModeLabels();
  hideNameSuggestions();
}

// ---------- 商品登録オーバーレイ(AI写真判定・手動登録を共通の1つのオーバーレイで表示) ----------
const registerOverlayEl = document.getElementById("register-overlay");
const registerManualSectionEl = document.getElementById("register-manual-section");
const registerReviewSectionEl = document.getElementById("review-section");

export function openRegisterOverlay() {
  registerOverlayEl.classList.remove("hidden");
}

// 買い物リスト「購入済み」→在庫登録のときだけ設定される、対象の買い物リスト行id。
// このモードで登録が完了したら、その行を削除するために使う
let purchaseShoppingId = null;

// AI写真判定・手動登録どちらの完了/キャンセル時からも呼ばれる共通の閉じる処理
export function closeRegisterOverlay() {
  registerOverlayEl.classList.add("hidden");
  resetManualRegisterForm();
  document.getElementById("manual-add-message").textContent = "";
  registerReviewSectionEl.classList.add("hidden");
  document.getElementById("review-list").innerHTML = "";
  document.getElementById("review-message").textContent = "";
  // 買い物リストの購入モードで隠していた場合に備え、必ず元の状態へ戻す
  document.getElementById("add-to-shopping-manual-btn").classList.remove("hidden");
  purchaseShoppingId = null;
}

// ホーム画面(home.js)の「登録 > 手動」ボタンから呼ばれる入口
export function openRegisterManualOverlay() {
  registerReviewSectionEl.classList.add("hidden");
  registerManualSectionEl.classList.remove("hidden");
  openRegisterOverlay();
  loadNameSuggestionPool();
  loadPriceAverages();
  updateUnitSuggestions(); // 商品名が未入力の段階から既定の単位チップを表示する
}

// 買い物リスト「購入済み」(js/shoppingPurchase.js)から呼ばれる入口。
// 手動登録と同じウィンドウ・同じ入力欄をそのまま使い、商品名・単位・数量を
// 買い物リストの内容で初期値にする。「買い物リストに追加」ボタンは意味を持たないため隠す。
// 既存商品(isKnownItem)の場合は単位がすでに確定しているため、自動推定で上書きしないよう
// 値をそのまま設定するだけにする(新規商品は手動登録と同じ自動提案をそのまま使う)
export function openRegisterManualOverlayForPurchase({ shoppingId, name, unit, quantity, isKnownItem }) {
  registerReviewSectionEl.classList.add("hidden");
  registerManualSectionEl.classList.remove("hidden");
  openRegisterOverlay();

  document.getElementById("item-type-fallback").classList.add("hidden");
  document.getElementById("item-expiry").value = "";
  document.getElementById("item-price").value = "";
  priceManuallyEdited = false;
  document.getElementById("add-to-shopping-manual-btn").classList.add("hidden");
  hideNameSuggestions();

  document.getElementById("item-name").value = name || "";

  manualQuantityValue = quantity || 1;
  manualQuantityTouched = true; // 買い物リストの数量をそのまま使うので、単位変更で上書きしない
  renderManualQuantityQuickAdjustLabels();
  renderManualQuantityDisplay();

  if (isKnownItem) {
    document.getElementById("item-unit").value = unit || "個";
    document.getElementById("item-unit-suggestions").innerHTML = "";
  } else {
    document.getElementById("item-unit").value = "個";
    updateUnitSuggestions(); // 新規商品は手動登録と同じ、商品名からの単位自動提案を行う
  }
  setPriceMode("total");
  updatePriceModeLabels();

  loadNameSuggestionPool();
  loadPriceAverages().then(() => applyPricePrefill(document.getElementById("item-name").value));
  purchaseShoppingId = shoppingId;
}

document.getElementById("register-overlay-close-btn").addEventListener("click", closeRegisterOverlay);
registerOverlayEl.addEventListener("click", (e) => {
  if (e.target === registerOverlayEl) closeRegisterOverlay();
});

// ---------- 商品名の予測変換(既存の登録済み商品名・標準商品名を候補表示) ----------
//
// 手動登録オーバーレイを開いた時に一度だけ取得し(件数が少ないため)、以降は入力の
// たびにクライアント側でフィルタする。AI呼び出し・デバウンスは不要
let nameSuggestionPool = [];
let lastSelectedSuggestionValue = null;
// 予測候補(標準商品名・既存商品名のどちらでも)を選んだ直後だけtrueにし、予測欄に
// 「詳細を入力する」の選択肢を追加表示する(詳細は`js/items.js`のparseNameWithDetail参照)。
// detailOptionAnchorValueは選択した時点の値で、以後この値のままである間だけ表示を維持する
let showDetailEntryOption = false;
let detailOptionAnchorValue = null;

async function loadNameSuggestionPool() {
  const [{ data: itemRows }, { data: masterRows }] = await Promise.all([
    supabaseClient.from("items").select("name"),
    supabaseClient.from("product_master").select("id, canonical_name, canonical_name_reading")
  ]);

  const seen = new Set();
  const pool = [];

  (itemRows || []).forEach(row => {
    const name = (row.name || "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    pool.push({ text: name, isCanonical: false });
  });

  (masterRows || []).forEach(row => {
    const name = (row.canonical_name || "").trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    pool.push({ text: name, reading: row.canonical_name_reading || "", isCanonical: true, productMasterId: row.id });
  });

  nameSuggestionPool = pool;
}

// ---------- 価格の初期値(過去の平均価格をプリフィルする) ----------
//
// 商品名欄の「,」より前(parseNameWithDetailの検索キー)が、既存の商品名または
// 標準商品名と完全一致(normalizeProductNameでの比較)した場合に、その平均価格
// (整数に丸める)を価格欄へ自動入力する。商品名が一致すればその商品名だけの
// 平均、無ければ標準商品名が同じすべての商品の平均を使う。ユーザーが価格欄を
// 一度でも手動編集したら、以後は自動上書きしない
let itemPriceAverageByNormalizedName = new Map();
let masterPriceAverageByMasterId = new Map();
let priceManuallyEdited = false;

async function loadPriceAverages() {
  const { data: lots } = await supabaseClient
    .from("item_lots")
    .select("price, items(name, product_master_id)");

  const itemAgg = new Map();
  const masterAgg = new Map();

  (lots || []).forEach(lot => {
    if (lot.price === null || lot.price === undefined) return;
    const item = lot.items;
    if (!item) return;
    const price = Number(lot.price);

    const normalizedName = normalizeProductName(item.name);
    if (normalizedName) {
      const cur = itemAgg.get(normalizedName) || { sum: 0, count: 0 };
      cur.sum += price;
      cur.count += 1;
      itemAgg.set(normalizedName, cur);
    }

    if (item.product_master_id) {
      const cur = masterAgg.get(item.product_master_id) || { sum: 0, count: 0 };
      cur.sum += price;
      cur.count += 1;
      masterAgg.set(item.product_master_id, cur);
    }
  });

  itemPriceAverageByNormalizedName = itemAgg;
  masterPriceAverageByMasterId = masterAgg;
}

// 検索キー(商品名欄の「,」より前)から、平均価格(整数)を求める。
// 商品名(items.name)への完全一致を優先し、無ければ標準商品名(canonical_name)への
// 完全一致を試す。どちらにも一致しなければnull
function findPriceSuggestion(searchName) {
  const normalized = normalizeProductName(searchName);
  if (!normalized) return null;

  const itemAvg = itemPriceAverageByNormalizedName.get(normalized);
  if (itemAvg && itemAvg.count > 0) return Math.round(itemAvg.sum / itemAvg.count);

  const masterEntry = nameSuggestionPool.find(e => e.isCanonical && normalizeProductName(e.text) === normalized);
  if (masterEntry && masterEntry.productMasterId) {
    const masterAvg = masterPriceAverageByMasterId.get(masterEntry.productMasterId);
    if (masterAvg && masterAvg.count > 0) return Math.round(masterAvg.sum / masterAvg.count);
  }

  return null;
}

function applyPricePrefill(rawValue) {
  if (priceManuallyEdited) return;
  const { searchName } = parseNameWithDetail(rawValue);
  const suggested = findPriceSuggestion(searchName);
  if (suggested !== null) {
    // 平均価格は常に「1つ当たりの単価」なので、モードもそちらに合わせる
    document.getElementById("item-price").value = suggested;
    setPriceMode("unit");
  } else {
    document.getElementById("item-price").value = "";
    setPriceMode("total");
  }
}

// ユーザーが価格欄を一度でも手動編集したら、以後は自動プリフィルで上書きしない
document.getElementById("item-price").addEventListener("input", () => {
  priceManuallyEdited = true;
});

// 一致度: 完全一致 > 前方一致 > 部分一致(標準商品名はひらがな読みも対象に判定する)
function matchQuality(text, t) {
  if (!text) return 0;
  if (text === t) return 3;
  if (text.startsWith(t)) return 2;
  if (text.includes(t)) return 1;
  return 0;
}

function suggestionMatchQuality(entry, t) {
  let quality = matchQuality(entry.text.toLowerCase(), t);
  if (entry.isCanonical && entry.reading) {
    quality = Math.max(quality, matchQuality(entry.reading, t));
  }
  return quality;
}

// 部分一致するものを、[商品名を優先度上・標準商品名を優先度下] → [一致度が高い順] → [五十音順] で並べる。
// 商品名欄には基本的に具体的な商品名を入力するため、汎用的な標準商品名は一致度が高くても
// あえて下位に置く(選ぶと具体的な名前ではなく汎用名に置き換わってしまうため)。
// 完全一致(quality===3)は、すでに入力欄の内容そのものなので候補として出す意味が無く、
// 標準商品名を選んだ直後に予測を表示し続ける仕様と組み合わせると選んだ本人が
// 候補に残り続けて見えてしまうため除外する
function filterNameSuggestions(term) {
  const t = term.toLowerCase();
  return nameSuggestionPool
    .map(entry => ({ entry, quality: suggestionMatchQuality(entry, t) }))
    .filter(s => s.quality > 0 && s.quality < 3)
    .sort((a, b) => {
      const tierA = a.entry.isCanonical ? 1 : 0;
      const tierB = b.entry.isCanonical ? 1 : 0;
      if (tierA !== tierB) return tierA - tierB;
      if (a.quality !== b.quality) return b.quality - a.quality;
      return a.entry.text.localeCompare(b.entry.text, "ja");
    })
    .slice(0, 8)
    .map(s => s.entry);
}

// 予測欄の表示/非表示と合わせて、入力欄の下端の角丸も切り替える。
// 開いている間は下端を角丸なしにして予測欄と一体化させ(Chromeの検索欄と同じ見た目)、
// 閉じたら通常どおり四隅とも角丸に戻す
function setNameSuggestionsVisible(visible) {
  const suggestionsEl = document.getElementById("item-name-suggestions");
  const nameInput = document.getElementById("item-name");
  suggestionsEl.classList.toggle("hidden", !visible);
  nameInput.classList.toggle("suggestions-open", visible);
}

function hideNameSuggestions() {
  clearTimeout(suggestionsHideTimer);
  setNameSuggestionsVisible(false);
  document.getElementById("item-name-suggestions").innerHTML = "";
  lastSelectedSuggestionValue = null;
  showDetailEntryOption = false;
  detailOptionAnchorValue = null;
}

// 標準商品名の候補は、文字の開始位置がずれて読みにくくならないよう、
// バッジ「標準」をテキストの右端に小さく表示する。先頭の「・」は検索アイコンの代わりの
// 目印(このアプリでは「検索」ではなく「候補の提示」なので、機能を連想させない記号にしている)
// 「詳細を入力する」の行(予測候補を選んだ直後だけ表示。タップすると入力欄の末尾に
// 「,」を追記し、続けて詳細(例:「小間切れ」)を入力できるようにする)
function detailEntryRowHtml() {
  return `
    <div class="name-suggestion-row name-suggestion-detail-row" data-action="append-name-detail">
      <span class="name-suggestion-mark">✏️</span>
      <span class="name-suggestion-text">詳細を入力する</span>
    </div>
  `;
}

function renderNameSuggestions(term) {
  const suggestionsEl = document.getElementById("item-name-suggestions");
  const matches = term ? filterNameSuggestions(term) : [];
  const detailRow = showDetailEntryOption ? detailEntryRowHtml() : "";

  if (matches.length === 0 && !detailRow) {
    setNameSuggestionsVisible(false);
    suggestionsEl.innerHTML = "";
    return;
  }

  suggestionsEl.innerHTML = `
    ${matches.map(m => `
      <div class="name-suggestion-row" data-value="${escapeHtml(m.text)}" data-canonical="${m.isCanonical}">
        <span class="name-suggestion-mark">・</span>
        <span class="name-suggestion-text">${escapeHtml(m.text)}</span>
        ${m.isCanonical ? '<span class="name-suggestion-badge">標準</span>' : ""}
      </div>
    `).join("")}
    ${detailRow}
  `;
  setNameSuggestionsVisible(true);
}

const itemNameInput = document.getElementById("item-name");
const itemNameSuggestionsEl = document.getElementById("item-name-suggestions");
// blurで閉じる予約タイマー。再フォーカス・再入力があれば古い予約は必ず取り消す
// (取り消さないと、直後に表示し直した候補を後から誤って閉じてしまうことがあるため)
let suggestionsHideTimer = null;

itemNameInput.addEventListener("input", () => {
  clearTimeout(suggestionsHideTimer);
  const value = itemNameInput.value.trim();
  // 商品名候補(標準商品名ではない方)を選んだ直後で値が変わっていなければ、通常の予測は
  // 表示しないが、「詳細を入力する」の選択肢(showDetailEntryOptionがtrueの間)だけは見せる
  // (標準商品名を選んだ場合はlastSelectedSuggestionValueを記録していないため、ここには来ない)
  if (value && value === lastSelectedSuggestionValue) {
    renderNameSuggestions("");
    applyPricePrefill(value);
    return;
  }
  // 選択直後の値からさらに変更された場合は、詳細入力オプションは役目を終えたので消す
  if (!(value && value === detailOptionAnchorValue)) {
    showDetailEntryOption = false;
  }
  lastSelectedSuggestionValue = null;
  renderNameSuggestions(value);
  applyPricePrefill(value);
});

itemNameInput.addEventListener("focus", () => {
  clearTimeout(suggestionsHideTimer);
  const value = itemNameInput.value.trim();
  if (value && value !== lastSelectedSuggestionValue) renderNameSuggestions(value);
});

// クリックより先にblurが発火して候補が消えてしまわないよう、mousedownの時点で確定させる
itemNameSuggestionsEl.addEventListener("mousedown", (e) => {
  // 「詳細を入力する」行: 入力欄の末尾に「,」を追記し、続けて詳細を入力できるようにする
  const detailRow = e.target.closest('[data-action="append-name-detail"]');
  if (detailRow) {
    e.preventDefault();
    clearTimeout(suggestionsHideTimer);
    itemNameInput.value = itemNameInput.value + ",";
    lastSelectedSuggestionValue = null;
    showDetailEntryOption = false;
    detailOptionAnchorValue = null;
    setNameSuggestionsVisible(false);
    itemNameInput.focus();
    itemNameInput.setSelectionRange(itemNameInput.value.length, itemNameInput.value.length);
    return;
  }

  const row = e.target.closest(".name-suggestion-row");
  if (!row) return;
  e.preventDefault();
  clearTimeout(suggestionsHideTimer);
  const isCanonical = row.dataset.canonical === "true";
  itemNameInput.value = row.dataset.value;
  // 商品名候補を選んだ場合だけ「選択済み」として記録し、以後変更がなければ予測を閉じたままにする。
  // 標準商品名を選んだ場合は、その名前に一致する商品名候補が新たに出てくる可能性があるため
  // あえて記録せず、下のinputイベントで予測を表示し続ける
  lastSelectedSuggestionValue = isCanonical ? null : row.dataset.value;
  // 選択直後だけ「詳細を入力する」の選択肢を表示する
  showDetailEntryOption = true;
  detailOptionAnchorValue = row.dataset.value;
  // 単位の自動推定・予測欄の表示更新など、既存のinputリスナーに反映させる
  itemNameInput.dispatchEvent(new Event("input", { bubbles: true }));
});

itemNameInput.addEventListener("blur", () => {
  suggestionsHideTimer = setTimeout(() => setNameSuggestionsVisible(false), 150);
});

const inventorySearchInput = document.getElementById("inventory-search");

// カテゴリー/サブカテゴリーと掛け合わせる追加の絞り込み検索。消費画面の検索と同じく、
// 1文字ごとの問い合わせを避けるため軽くデバウンスする
let inventorySearchDebounceTimer = null;
inventorySearchInput.addEventListener("input", () => {
  clearTimeout(inventorySearchDebounceTimer);
  inventorySearchDebounceTimer = setTimeout(() => loadItems(), 280);
});

// ---------- 在庫確認の絞り込みフィルター(Amazonアプリ風の2ペイン、複数選択) ----------
//
// 種別→カテゴリー→サブカテゴリーの順にカスケードする(種別を選ぶとカテゴリーの選択肢が
// 絞られ、カテゴリーを選ぶとサブカテゴリーの選択肢が絞られる)。
// 今後「登録日」「購入金額」「消費期限」などを追加する場合は、この配列に定義を足すだけで
// 左側の種類一覧に反映される(現時点はチェックボックス一覧形式のみ実装している)
const inventoryFilterDefs = [
  { key: "type", label: "種別" },
  { key: "category", label: "カテゴリー" },
  { key: "subcategory", label: "サブカテゴリー" }
];

// 実際の絞り込みに使われている確定済みの選択(種類ごとにSet)
const appliedInventoryFilters = { type: new Set(), category: new Set(), subcategory: new Set() };
// フィルター画面を開いている間だけの一時的な選択。「結果を表示」を押すまでappliedへ反映しない
let stagedInventoryFilters = { type: new Set(), category: new Set(), subcategory: new Set() };
let activeInventoryFilterKey = inventoryFilterDefs[0].key;
// loadItems()が最後に取得した全件。フィルター画面の選択肢(種別/カテゴリー/サブカテゴリーの一覧)を作るのに使う
let latestAllItems = [];

function computeTypeOptions(allItems) {
  return Array.from(new Set(allItems.map(effectiveType).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
}
function computeCategoryOptions(allItems, selectedTypes) {
  const relevant = selectedTypes.size > 0
    ? allItems.filter(item => selectedTypes.has(effectiveType(item)))
    : allItems;
  return Array.from(new Set(relevant.map(effectiveCategory).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
}
function computeSubcategoryOptions(allItems, selectedTypes, selectedCategories) {
  let relevant = allItems;
  if (selectedTypes.size > 0) relevant = relevant.filter(item => selectedTypes.has(effectiveType(item)));
  if (selectedCategories.size > 0) relevant = relevant.filter(item => selectedCategories.has(effectiveCategory(item)));
  return Array.from(new Set(relevant.map(effectiveSubCategory).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
}

function optionsForFilterKey(key) {
  if (key === "type") return computeTypeOptions(latestAllItems);
  if (key === "category") return computeCategoryOptions(latestAllItems, stagedInventoryFilters.type);
  if (key === "subcategory") return computeSubcategoryOptions(latestAllItems, stagedInventoryFilters.type, stagedInventoryFilters.category);
  return [];
}

function renderInventoryFilterTypes() {
  document.getElementById("inventory-filter-types").innerHTML = inventoryFilterDefs.map(def => {
    const count = stagedInventoryFilters[def.key].size;
    return `
      <div class="filter-type-row ${def.key === activeInventoryFilterKey ? "active" : ""}" data-key="${def.key}">
        ${escapeHtml(def.label)}${count > 0 ? ` (${count})` : ""}
      </div>
    `;
  }).join("");
}

function renderInventoryFilterOptions() {
  const el = document.getElementById("inventory-filter-options");
  const options = optionsForFilterKey(activeInventoryFilterKey);

  if (options.length === 0) {
    el.innerHTML = '<div class="empty-note">選択肢がありません</div>';
    return;
  }

  el.innerHTML = options.map(opt => {
    const checked = stagedInventoryFilters[activeInventoryFilterKey].has(opt);
    return `
      <div class="filter-option-row" data-value="${escapeHtml(opt)}">
        <span class="filter-option-checkbox ${checked ? "checked" : ""}"><span class="material-symbols-rounded">check</span></span>
        <span>${escapeHtml(opt)}</span>
      </div>
    `;
  }).join("");
}

// 選択中のフィルターを「[飲料] > [清涼飲料水]」のように案内文で表示する。
// カテゴリー・サブカテゴリーのように親子関係にある種類は" > "で、複数選択は「・」で連結する
function renderInventoryFilterSummary() {
  const el = document.getElementById("inventory-filter-summary");
  const parts = [];
  if (stagedInventoryFilters.type.size > 0) {
    parts.push(`[${Array.from(stagedInventoryFilters.type).join("・")}]`);
  }
  if (stagedInventoryFilters.category.size > 0) {
    parts.push(`[${Array.from(stagedInventoryFilters.category).join("・")}]`);
  }
  if (stagedInventoryFilters.subcategory.size > 0) {
    parts.push(`[${Array.from(stagedInventoryFilters.subcategory).join("・")}]`);
  }
  const text = parts.join(" > ");
  el.textContent = text;
  el.classList.toggle("hidden", !text);
}

document.getElementById("inventory-filter-types").addEventListener("click", (e) => {
  const row = e.target.closest(".filter-type-row");
  if (!row) return;
  activeInventoryFilterKey = row.dataset.key;
  renderInventoryFilterTypes();
  renderInventoryFilterOptions();
});

document.getElementById("inventory-filter-options").addEventListener("click", (e) => {
  const row = e.target.closest(".filter-option-row");
  if (!row) return;
  const set = stagedInventoryFilters[activeInventoryFilterKey];
  const value = row.dataset.value;
  if (set.has(value)) set.delete(value); else set.add(value);

  // 種別・カテゴリーの選択を変えたら、対象外になったカテゴリー・サブカテゴリーの選択は外す(カスケード)
  if (activeInventoryFilterKey === "type") {
    const validCats = new Set(computeCategoryOptions(latestAllItems, stagedInventoryFilters.type));
    Array.from(stagedInventoryFilters.category).forEach(cat => {
      if (!validCats.has(cat)) stagedInventoryFilters.category.delete(cat);
    });
  }
  if (activeInventoryFilterKey === "type" || activeInventoryFilterKey === "category") {
    const validSubs = new Set(computeSubcategoryOptions(latestAllItems, stagedInventoryFilters.type, stagedInventoryFilters.category));
    Array.from(stagedInventoryFilters.subcategory).forEach(sub => {
      if (!validSubs.has(sub)) stagedInventoryFilters.subcategory.delete(sub);
    });
  }

  renderInventoryFilterTypes();
  renderInventoryFilterOptions();
  renderInventoryFilterSummary();
});

function openInventoryFilterOverlay() {
  // 確定済みの選択をコピーして一時状態にする(閉じるだけで確定しなければ破棄される)
  stagedInventoryFilters = {
    type: new Set(appliedInventoryFilters.type),
    category: new Set(appliedInventoryFilters.category),
    subcategory: new Set(appliedInventoryFilters.subcategory)
  };
  activeInventoryFilterKey = inventoryFilterDefs[0].key;
  renderInventoryFilterTypes();
  renderInventoryFilterOptions();
  renderInventoryFilterSummary();
  document.getElementById("inventory-filter-overlay").classList.remove("hidden");
}
function closeInventoryFilterOverlay() {
  document.getElementById("inventory-filter-overlay").classList.add("hidden");
}

function updateInventoryFilterButtonLabel() {
  const total = appliedInventoryFilters.type.size + appliedInventoryFilters.category.size + appliedInventoryFilters.subcategory.size;
  document.querySelector("#inventory-filter-btn .inventory-filter-btn-label").textContent =
    total > 0 ? `フィルター (${total})` : "フィルター";
}

document.getElementById("inventory-filter-btn").addEventListener("click", openInventoryFilterOverlay);
document.getElementById("inventory-filter-close-btn").addEventListener("click", closeInventoryFilterOverlay);
document.getElementById("inventory-filter-overlay").addEventListener("click", (e) => {
  if (e.target.id === "inventory-filter-overlay") closeInventoryFilterOverlay();
});

// 「フィルターを解除」: その場で選択をクリアするだけ(パネルは開いたまま)。
// 反映するには「結果を表示」を押す必要がある
document.getElementById("inventory-filter-clear-btn").addEventListener("click", () => {
  stagedInventoryFilters = { type: new Set(), category: new Set(), subcategory: new Set() };
  renderInventoryFilterTypes();
  renderInventoryFilterOptions();
  renderInventoryFilterSummary();
});

document.getElementById("inventory-filter-apply-btn").addEventListener("click", () => {
  appliedInventoryFilters.type = new Set(stagedInventoryFilters.type);
  appliedInventoryFilters.category = new Set(stagedInventoryFilters.category);
  appliedInventoryFilters.subcategory = new Set(stagedInventoryFilters.subcategory);
  closeInventoryFilterOverlay();
  loadItems();
});

// ---------- 在庫確認の並び替え(カテゴリ/サブカテゴリ/カード/カード内を独立して設定) ----------
//
// 「カテゴリ」「サブカテゴリ」「カード(同じサブカテゴリー内でどの商品が上に来るか)」
// 「カード内(1枚のカードの中で商品名ごとの区画がどちらが上に来るか)」の4階層を、
// それぞれ独立に[期限/登録日/50音 × 昇順/降順]で並び替えられる。
// 「すべて」タブは実体を持たず、選ぶと4階層すべてに同じ設定を一括反映するだけの特別なタブ。
// 何も設定していない階層は、これまで通りの既定の並び順(カテゴリー/サブカテゴリーは文字コード順、
// カード/カード内は賞味期限が近い順)のまま変わらない。
//
// 「登録日」で並び替えるには items.created_at が必要(Supabaseの標準的な作成日時列を想定)。
// この列が実際に存在しない場合、登録日での並び替えは効かない(全件同値扱いになり元の順序が保たれる)。
const INVENTORY_SORT_CRITERIA = [
  { key: "expiry", label: "期限", directions: [
      { key: "asc", label: "期限が近い順" },
      { key: "desc", label: "期限が遠い順" }
    ] },
  { key: "registeredAt", label: "登録日", directions: [
      { key: "desc", label: "登録日が新しい順" },
      { key: "asc", label: "登録日が古い順" }
    ] },
  { key: "name", label: "50音", directions: [
      { key: "asc", label: "50音順(あ→わ)" },
      { key: "desc", label: "50音順(わ→あ)" }
    ] }
];

const INVENTORY_SORT_LEVELS = [
  { key: "category", label: "カテゴリ" },
  { key: "subcategory", label: "サブカテゴリ" },
  { key: "card", label: "カード" },
  { key: "cardInner", label: "カード内" }
];

const INVENTORY_SORT_DEFAULT_STORAGE_KEY = "kurasInventorySortDefault";

function loadSavedInventorySortDefault() {
  try {
    const raw = localStorage.getItem(INVENTORY_SORT_DEFAULT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function saveInventorySortDefault(config) {
  try {
    localStorage.setItem(INVENTORY_SORT_DEFAULT_STORAGE_KEY, JSON.stringify(config));
  } catch (e) {
    console.error("並び替えの既定値保存に失敗:", e);
  }
}

function emptySortByLevel() {
  return { category: null, subcategory: null, card: null, cardInner: null };
}
function cloneSortByLevel(source) {
  return { category: source.category, subcategory: source.subcategory, card: source.card, cardInner: source.cardInner };
}
function sortLevelsAreEqual(a, b) {
  if (!a && !b) return true;
  return !!a && !!b && a.key === b.key && a.direction === b.direction;
}

// 実際に一覧へ反映されている確定済みの設定(ブラウザに保存済みの既定値があればそれを初期値にする)
const appliedInventorySortByLevel = loadSavedInventorySortDefault() || emptySortByLevel();
// オーバーレイを開いている間だけの一時状態。「並び替え」を押すまでappliedへ反映しない
let stagedInventorySortByLevel = emptySortByLevel();
let activeInventorySortTab = "all"; // "all" | "category" | "subcategory" | "card" | "cardInner"
let activeInventorySortCriterionKey = "expiry";

// 現在の全階層が、指定した設定(nullも含む)ですべて一致しているか。「すべて」タブのチェック状態表示に使う
function allInventorySortLevelsMatch(config) {
  return INVENTORY_SORT_LEVELS.every(level => sortLevelsAreEqual(stagedInventorySortByLevel[level.key], config));
}

function renderInventorySortLevelTabs() {
  const el = document.getElementById("inventory-sort-level-tabs");
  const allTab = `<div class="sort-level-tab all-tab ${activeInventorySortTab === "all" ? "active" : ""}" data-key="all">すべて</div>`;
  const levelTabs = INVENTORY_SORT_LEVELS.map(level =>
    `<div class="sort-level-tab ${activeInventorySortTab === level.key ? "active" : ""}" data-key="${level.key}">${escapeHtml(level.label)}</div>`
  ).join("");
  el.innerHTML = allTab + levelTabs;
}

function renderInventorySortCriteria() {
  document.getElementById("inventory-sort-types").innerHTML = INVENTORY_SORT_CRITERIA.map(def =>
    `<div class="filter-type-row ${def.key === activeInventorySortCriterionKey ? "active" : ""}" data-key="${def.key}">${escapeHtml(def.label)}</div>`
  ).join("");
}

function renderInventorySortDirections() {
  const el = document.getElementById("inventory-sort-directions");
  const def = INVENTORY_SORT_CRITERIA.find(c => c.key === activeInventorySortCriterionKey);
  el.innerHTML = def.directions.map(dir => {
    const candidate = { key: def.key, direction: dir.key };
    const checked = activeInventorySortTab === "all"
      ? allInventorySortLevelsMatch(candidate)
      : sortLevelsAreEqual(stagedInventorySortByLevel[activeInventorySortTab], candidate);
    return `
      <div class="filter-option-row" data-direction="${dir.key}">
        <span class="filter-option-checkbox ${checked ? "checked" : ""}"><span class="material-symbols-rounded">check</span></span>
        <span>${escapeHtml(dir.label)}</span>
      </div>
    `;
  }).join("");
}

// 選択中の並び替えを案内文で表示する(例:「期限が近い順」)。「すべて」タブでは
// 4階層すべてが同じ設定で揃っている場合だけ表示する(揃っていなければ何も表示しない)
function renderInventorySortSummary() {
  const el = document.getElementById("inventory-sort-summary");
  let config = null;

  if (activeInventorySortTab === "all") {
    const candidate = stagedInventorySortByLevel.category;
    config = allInventorySortLevelsMatch(candidate) ? candidate : null;
  } else {
    config = stagedInventorySortByLevel[activeInventorySortTab];
  }

  let text = "";
  if (config) {
    const def = INVENTORY_SORT_CRITERIA.find(c => c.key === config.key);
    const dir = def.directions.find(d => d.key === config.direction);
    text = dir.label;
  }

  el.textContent = text;
  el.classList.toggle("hidden", !text);
}

document.getElementById("inventory-sort-level-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".sort-level-tab");
  if (!tab) return;
  activeInventorySortTab = tab.dataset.key;
  renderInventorySortLevelTabs();
  renderInventorySortDirections();
  renderInventorySortSummary();
});

document.getElementById("inventory-sort-types").addEventListener("click", (e) => {
  const row = e.target.closest(".filter-type-row");
  if (!row) return;
  activeInventorySortCriterionKey = row.dataset.key;
  renderInventorySortCriteria();
  renderInventorySortDirections();
  renderInventorySortSummary();
});

document.getElementById("inventory-sort-directions").addEventListener("click", (e) => {
  const row = e.target.closest(".filter-option-row");
  if (!row) return;
  const candidate = { key: activeInventorySortCriterionKey, direction: row.dataset.direction };

  if (activeInventorySortTab === "all") {
    const shouldClear = allInventorySortLevelsMatch(candidate);
    INVENTORY_SORT_LEVELS.forEach(level => {
      stagedInventorySortByLevel[level.key] = shouldClear ? null : { ...candidate };
    });
  } else {
    const current = stagedInventorySortByLevel[activeInventorySortTab];
    stagedInventorySortByLevel[activeInventorySortTab] = sortLevelsAreEqual(current, candidate) ? null : { ...candidate };
  }

  renderInventorySortDirections();
  renderInventorySortSummary();
});

function openInventorySortOverlay() {
  stagedInventorySortByLevel = cloneSortByLevel(appliedInventorySortByLevel);
  activeInventorySortTab = "all";
  activeInventorySortCriterionKey = "expiry";
  renderInventorySortLevelTabs();
  renderInventorySortCriteria();
  renderInventorySortDirections();
  renderInventorySortSummary();
  document.getElementById("inventory-sort-overlay").classList.remove("hidden");
}
function closeInventorySortOverlay() {
  document.getElementById("inventory-sort-overlay").classList.add("hidden");
}

document.getElementById("inventory-sort-btn").addEventListener("click", openInventorySortOverlay);
document.getElementById("inventory-sort-close-btn").addEventListener("click", closeInventorySortOverlay);
document.getElementById("inventory-sort-overlay").addEventListener("click", (e) => {
  if (e.target.id === "inventory-sort-overlay") closeInventorySortOverlay();
});

// 「デフォルトに戻す」: 保存済みの既定値(無ければ「並び替えなし」)を選択状態に反映するだけ(パネルは開いたまま)
document.getElementById("inventory-sort-clear-btn").addEventListener("click", () => {
  stagedInventorySortByLevel = loadSavedInventorySortDefault() || emptySortByLevel();
  renderInventorySortLevelTabs();
  renderInventorySortDirections();
  renderInventorySortSummary();
});

// 「デフォルトに設定」: 現在選択中の内容(4階層すべて)をブラウザに保存する(反映はしない)
document.getElementById("inventory-sort-default-btn").addEventListener("click", () => {
  saveInventorySortDefault(stagedInventorySortByLevel);
  showAppNotice("この並び替えをデフォルトに設定しました");
});

document.getElementById("inventory-sort-apply-btn").addEventListener("click", () => {
  appliedInventorySortByLevel.category = stagedInventorySortByLevel.category;
  appliedInventorySortByLevel.subcategory = stagedInventorySortByLevel.subcategory;
  appliedInventorySortByLevel.card = stagedInventorySortByLevel.card;
  appliedInventorySortByLevel.cardInner = stagedInventorySortByLevel.cardInner;
  closeInventorySortOverlay();
  loadItems();
});

// 並び替え(期限・登録日・50音)の値比較。方向を考慮し、aが良ければ負、bが良ければ正を返す。
// 期限・登録日はnull(未設定)を常に最後に回す
function compareInventorySortValues(criterion, direction, a, b) {
  if (criterion === "name") {
    const result = (a || "").localeCompare(b || "", "ja");
    return direction === "asc" ? result : -result;
  }
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const result = a < b ? -1 : a > b ? 1 : 0;
  return direction === "asc" ? result : -result;
}

// aとbのうち、その並び替えで「より良い(先に来る)」方を返す
function betterInventorySortValue(criterion, direction, a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareInventorySortValues(criterion, direction, a, b) <= 0 ? a : b;
}

// 複数の子要素から、getValueで取れる値のうち最良のものを1つ選ぶ。
// カード→サブカテゴリー→カテゴリーと、階層をまたいで基準値を伝播させるのに使う
function foldBestInventorySortValue(children, getValue, criterion, direction) {
  const best = children.reduce((acc, child) => betterInventorySortValue(criterion, direction, acc, getValue(child)), undefined);
  return best === undefined ? null : best;
}

// 1商品(items 1行)の並び替え用の値。期限は商品内の全ロットの中からその方向で最良のもの
// (近い順なら最も近い期限)を採用する
function itemInventorySortValue(item, criterion, direction) {
  if (criterion === "name") {
    return (item.product_master && item.product_master.canonical_name) || item.name;
  }
  if (criterion === "registeredAt") {
    return item.created_at || null;
  }
  if (criterion === "expiry") {
    const dates = (item.item_lots || []).map(l => l.expiry_date).filter(Boolean);
    return foldBestInventorySortValue(dates, d => d, criterion, direction);
  }
  return null;
}

function groupInventorySortValue(group, criterion, direction) {
  return foldBestInventorySortValue(group, item => itemInventorySortValue(item, criterion, direction), criterion, direction);
}

function subcategoryInventorySortValue(groups, criterion, direction) {
  return foldBestInventorySortValue(groups, group => groupInventorySortValue(group, criterion, direction), criterion, direction);
}

function categoryInventorySortValue(subcatMap, criterion, direction) {
  return foldBestInventorySortValue(Object.values(subcatMap), groups => subcategoryInventorySortValue(groups, criterion, direction), criterion, direction);
}

// 商品名欄で「,」を使うと、前半だけを商品マスタ解決(resolveProductMaster)の検索キーに使い、
// 後半は検索に影響させず表示用の商品名にだけ反映する(例:「豚肉,小間切れ」→検索キー「豚肉」・
// 表示名「豚肉(小間切れ)」)。予測変換で標準商品名・既存商品名を選んだ直後の「詳細を入力する」
// ボタン(このファイル内)から使う想定の機能で、それ以外で「,」を含む商品名を入力した場合も
// 同じルールで解釈する。「,」が無ければ従来通りそのままの文字列を検索キー・表示名の両方に使う
function parseNameWithDetail(rawInput) {
  const commaIndex = rawInput.indexOf(",");
  if (commaIndex === -1) return { searchName: rawInput, displayName: rawInput };

  const before = rawInput.slice(0, commaIndex).trim();
  const after = rawInput.slice(commaIndex + 1).trim();
  if (!before) return { searchName: rawInput, displayName: rawInput };

  return { searchName: before, displayName: after ? `${before}(${after})` : before };
}

// 商品(items)を解決する。既存商品があればそのid、なければ新規作成してidを返す。
// category未指定の新規商品は、まず商品マスタ(AI)から種別(食品/日用品)を判定して
// items.categoryへ自動反映する。商品マスタの判定に失敗した場合は登録せず、
// needsCategory:true を返して呼び出し元に種別の手入力を促す(AIの再呼び出しはしない)。
// productMasterStatus: 商品マスタ解決が行われた場合のみ "generated"(AIが新規生成)
// または "reused"(既存の商品属性を利用)。既存商品名にヒットした場合・種別を手入力した
// 場合(商品マスタ解決自体が行われない)は null。呼び出し元の登録完了メッセージで使う。
async function resolveItem({ name, category, unit }) {
  const rawInput = (name || "").trim();
  if (!rawInput) return { itemId: null, needsCategory: false, productMasterStatus: null };

  const { searchName, displayName } = parseNameWithDetail(rawInput);

  const { data: existingList, error: findError } = await supabaseClient
    .from("items")
    .select("id")
    .eq("name", displayName)
    .limit(1);

  if (findError) { console.error("既存商品の検索に失敗:", findError); return { itemId: null, needsCategory: false, productMasterStatus: null }; }

  if (existingList && existingList.length > 0) {
    return { itemId: existingList[0].id, needsCategory: false, productMasterStatus: null };
  }

  let resolvedCategory = category;
  let productMasterId = null;
  let productMasterStatus = null;

  if (!resolvedCategory) {
    const resolved = await resolveProductMaster(searchName);
    if (!resolved) return { itemId: null, needsCategory: true, productMasterStatus: null };
    resolvedCategory = resolved.master.type;
    productMasterId = resolved.master.id;
    productMasterStatus = resolved.generatedNew ? "generated" : "reused";
  }

  const { data: inserted, error: insertError } = await supabaseClient
    .from("items")
    .insert({
      name: displayName,
      category: resolvedCategory,
      unit,
      low_stock_threshold: 0,
      product_master_id: productMasterId
    })
    .select()
    .single();
  if (insertError) { console.error("商品の登録に失敗:", insertError); return { itemId: null, needsCategory: false, productMasterStatus: null }; }
  return { itemId: inserted.id, needsCategory: false, productMasterStatus };
}

// 購入・消費履歴(item_history)への記録。item_lotsは消費で0になると行ごと削除され、
// 購入時も既存ロットへ数量を加算する場合があるため「今の在庫状態」であって履歴ではない。
// 増減が起きるたびにこの関数で1行追記する(商品名・標準商品名はその時点のスナップショット)。
// quantityは常に正の値(増減量そのもの)を渡す
async function logItemHistory(itemId, eventType, quantity, price) {
  if (!quantity || quantity <= 0) return;

  const { data: item, error } = await supabaseClient
    .from("items")
    .select("name, unit, category, product_master_id, product_master(canonical_name, type)")
    .eq("id", itemId)
    .maybeSingle();
  if (error || !item) { console.error("履歴用の商品情報取得に失敗:", error); return; }

  const { error: insertError } = await supabaseClient.from("item_history").insert({
    item_id: itemId,
    item_name: item.name,
    unit: item.unit,
    product_master_id: item.product_master_id,
    canonical_name: item.product_master ? item.product_master.canonical_name : null,
    item_type: effectiveType(item),
    event_type: eventType,
    quantity: Number(quantity),
    price: (price === undefined || price === null || price === "") ? null : Number(price)
  });
  if (insertError) console.error("購入・消費履歴の記録に失敗:", insertError);
}

// 商品(itemId)に対して、同じ賞味期限(未設定同士も含む)のロットがあれば数量を加算、
// なければ新しいロットを作成する。賞味期限が異なる場合は必ず新規ロットになる。
// (買い物リストからの在庫登録など、既存商品にロットだけ追加したい他の処理からも再利用する)
// price: 未入力(null/undefined/空文字)なら記録しない(既存ロットへの加算時は既存の価格をそのまま残す)
export async function resolveLot(itemId, quantity, expiryDate, price) {
  let findQuery = supabaseClient.from("item_lots").select("id, quantity").eq("item_id", itemId);
  findQuery = expiryDate ? findQuery.eq("expiry_date", expiryDate) : findQuery.is("expiry_date", null);
  const { data: existingList, error: findError } = await findQuery.limit(1);

  if (findError) { console.error("既存ロットの検索に失敗:", findError); return null; }

  const existing = existingList && existingList.length > 0 ? existingList[0] : null;
  const priceValue = (price === undefined || price === null || price === "") ? null : Number(price);

  if (existing) {
    const newQuantity = Number(existing.quantity) + Number(quantity || 0);
    const updatePayload = { quantity: newQuantity, updated_at: new Date().toISOString() };
    if (priceValue !== null) updatePayload.price = priceValue;
    const { error: updateError } = await supabaseClient
      .from("item_lots")
      .update(updatePayload)
      .eq("id", existing.id);
    if (updateError) { console.error("ロットの更新に失敗:", updateError); return null; }
    await logItemHistory(itemId, "purchase", quantity, priceValue);
    return existing.id;
  } else {
    const { error: insertError } = await supabaseClient
      .from("item_lots")
      .insert({
        item_id: itemId,
        quantity: Number(quantity || 0),
        expiry_date: expiryDate || null,
        price: priceValue
      });
    if (insertError) { console.error("ロットの登録に失敗:", insertError); return null; }
    await logItemHistory(itemId, "purchase", quantity, priceValue);
    return true;
  }
}

// 商品を登録する(商品の解決 + ロットの解決をまとめた、既存呼び出し元向けの入口)。
// AI写真登録・手動登録のすべてがこの関数を経由する。
// 戻り値: 成功時は { itemId, productMasterStatus }、失敗時はnull、商品マスタの自動判定に
// 失敗し種別の手入力が必要な場合は { needsCategory: true }(呼び出し元はcategoryを付けて再実行する)
export async function upsertItemByName({ name, category, unit, quantity, expiry_date, price }) {
  const { itemId, needsCategory, productMasterStatus } = await resolveItem({ name, category, unit });
  if (needsCategory) return { needsCategory: true };
  if (!itemId) return null;

  const lotResult = await resolveLot(itemId, quantity, expiry_date, price);
  if (!lotResult) return null;

  await syncShoppingListForItem(itemId);
  return { itemId, productMasterStatus };
}

// カテゴリー/サブカテゴリーの代表値。商品マスタがあればその分類を優先し、
// 無ければ items.category をフォールバックに使う(サブカテゴリーはフォールバック列が無い)
function effectiveCategory(item) {
  return (item.product_master && item.product_master.category) || item.category || "その他";
}
function effectiveSubCategory(item) {
  return (item.product_master && item.product_master.sub_category) || null;
}
// 種別(食品/日用品)。商品マスタがあればその type、無ければ items.category に
// 直接この種別が入っている(resolveItem が商品マスタ未解決時のフォールバックとして保存するため)
function effectiveType(item) {
  return (item.product_master && item.product_master.type) || item.category || null;
}

export async function loadItems() {
  const { data, error } = await supabaseClient
    .from("items")
    .select("*, item_lots(*), product_master(canonical_name, canonical_name_reading, type, category, sub_category, sub_category_reading, search_keywords, search_keywords_reading, low_stock_threshold)")
    .order("name", { ascending: true });

  if (error) {
    itemListEl.innerHTML = '<div class="empty-note">読み込みエラー: ' + error.message + '</div>';
    return;
  }

  const allItems = data || [];
  latestAllItems = allItems;
  const searchTerm = inventorySearchInput.value.trim();

  // カテゴリー・サブカテゴリー(複数選択)・検索欄は、既存の並び順・見出しを変えずに
  // 掛け合わせる追加の絞り込みとして扱う(検索は消費画面と同じ優先度スコアリング。
  // 一致すれば採用、順位付けには使わない)
  const filtered = allItems.filter(item => {
    if (appliedInventoryFilters.type.size > 0 && !appliedInventoryFilters.type.has(effectiveType(item))) return false;
    if (appliedInventoryFilters.category.size > 0 && !appliedInventoryFilters.category.has(effectiveCategory(item))) return false;
    if (appliedInventoryFilters.subcategory.size > 0 && !appliedInventoryFilters.subcategory.has(effectiveSubCategory(item))) return false;
    if (searchTerm && computeItemSearchScore(item, searchTerm) === 0) return false;
    return true;
  });

  updateInventoryFilterButtonLabel();
  renderItems(filtered);
}

// 消費画面(js/consume.js)でも、ロット一覧を在庫確認画面と同じ見た目・並び順で表示するために再利用する
export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0,0,0,0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

// 賞味期限が近い順(未設定は最後)に並べる。ロットの標準的な並び順として使う
export function sortLotsByExpiry(lots) {
  return [...(lots || [])].sort((a, b) => {
    if (a.expiry_date && b.expiry_date) return a.expiry_date < b.expiry_date ? -1 : a.expiry_date > b.expiry_date ? 1 : 0;
    if (a.expiry_date && !b.expiry_date) return -1;
    if (!a.expiry_date && b.expiry_date) return 1;
    return 0;
  });
}

// ロット行の賞味期限表示(例:「期限:7/20 (あと3日)」)を組み立てる。
// 在庫確認画面・消費画面の両方で共通利用する
export function formatExpiryLabel(expiryDate) {
  const d = daysUntil(expiryDate);
  if (d === null) return { text: "期限未設定", statusClass: "" };

  const dt = new Date(expiryDate + "T00:00:00");
  const dateText = `${dt.getMonth() + 1}/${dt.getDate()}`;

  if (d < 0) return { text: `期限:${dateText} (期限切れ)`, statusClass: "expired" };
  if (d <= 3) return { text: `期限:${dateText} (あと${d}日)`, statusClass: "soon" };
  return { text: `期限:${dateText} (あと${d}日)`, statusClass: "" };
}

function earliestExpiry(item) {
  const dates = (item.item_lots || []).map(l => l.expiry_date).filter(Boolean).sort();
  return dates[0] || null;
}

// items.product_master_id が同じ商品を1つのグループにまとめる(標準商品名で束ねるため)。
// 商品マスタが無い商品は、自分だけの単独グループになる。
function groupItemsByMaster(items) {
  const map = new Map();
  items.forEach(item => {
    const key = item.product_master_id || ("item:" + item.id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  });
  return Array.from(map.values());
}

function renderItems(items) {
  if (!items || items.length === 0) {
    itemListEl.innerHTML = '<div class="empty-note">該当する商品がありません。</div>';
    return;
  }

  // 「カード」「カテゴリ」「サブカテゴリ」の並び替えが指定されていなければ、
  // 商品一覧は既定どおり「もっとも賞味期限が近いロット」を基準に並べる(未設定は最後)。
  // この下準備の並びは、カード/カテゴリ/サブカテゴリの並び替えが指定された場合は後で上書きされる
  const sortedItems = [...items].sort((a, b) => {
    const ea = earliestExpiry(a), eb = earliestExpiry(b);
    if (ea && eb) return ea < eb ? -1 : ea > eb ? 1 : 0;
    if (ea && !eb) return -1;
    if (!ea && eb) return 1;
    return a.name.localeCompare(b.name, "ja");
  });

  // 標準商品名(product_master)ごとに先にグループ化してからカテゴリーへ振り分けることで、
  // 万一グループ内で items.category が食い違っていてもグループが分断されないようにする
  const masterGroups = groupItemsByMaster(sortedItems);

  // 「カード内」の並び替えが指定されていれば、各カードの中の商品名区画の順序を並べ替える
  // (指定が無ければ、これまで通りグループ化時点の順序のまま)
  const cardInnerSort = appliedInventorySortByLevel.cardInner;
  if (cardInnerSort) {
    masterGroups.forEach(group => {
      group.sort((a, b) => compareInventorySortValues(
        cardInnerSort.key, cardInnerSort.direction,
        itemInventorySortValue(a, cardInnerSort.key, cardInnerSort.direction),
        itemInventorySortValue(b, cardInnerSort.key, cardInnerSort.direction)
      ));
    });
  }

  const buckets = {};
  masterGroups.forEach(group => {
    const category = effectiveCategory(group[0]);
    const subCategory = effectiveSubCategory(group[0]) || "未分類";
    buckets[category] = buckets[category] || {};
    buckets[category][subCategory] = buckets[category][subCategory] || [];
    buckets[category][subCategory].push(group);
  });

  // 「カード」の並び替えが指定されていれば、同じサブカテゴリー内でのカードの順序を並べ替える
  const cardSort = appliedInventorySortByLevel.card;
  if (cardSort) {
    Object.values(buckets).forEach(subcatMap => {
      Object.keys(subcatMap).forEach(subCategory => {
        subcatMap[subCategory].sort((a, b) => compareInventorySortValues(
          cardSort.key, cardSort.direction,
          groupInventorySortValue(a, cardSort.key, cardSort.direction),
          groupInventorySortValue(b, cardSort.key, cardSort.direction)
        ));
      });
    });
  }

  // 「カテゴリ」「サブカテゴリ」の並び替えが指定されていなければ、これまで通り文字コード順のまま
  const categorySort = appliedInventorySortByLevel.category;
  const subcategorySort = appliedInventorySortByLevel.subcategory;

  const categoryKeys = categorySort
    ? Object.keys(buckets).sort((a, b) => compareInventorySortValues(
        categorySort.key, categorySort.direction,
        categoryInventorySortValue(buckets[a], categorySort.key, categorySort.direction),
        categoryInventorySortValue(buckets[b], categorySort.key, categorySort.direction)
      ))
    : Object.keys(buckets).sort();

  let html = "";
  categoryKeys.forEach(category => {
    html += `<h3 class="group-heading">${escapeHtml(category)}</h3>`;
    const subcategoryKeys = subcategorySort
      ? Object.keys(buckets[category]).sort((a, b) => compareInventorySortValues(
          subcategorySort.key, subcategorySort.direction,
          subcategoryInventorySortValue(buckets[category][a], subcategorySort.key, subcategorySort.direction),
          subcategoryInventorySortValue(buckets[category][b], subcategorySort.key, subcategorySort.direction)
        ))
      : Object.keys(buckets[category]).sort();

    subcategoryKeys.forEach(subCategory => {
      html += `<h4 class="group-subheading">${escapeHtml(subCategory)}</h4>`;
      buckets[category][subCategory].forEach(group => { html += masterGroupCardHtml(group); });
    });
  });
  itemListEl.innerHTML = html;
}

function lotRowHtml(item, lot) {
  const { text: expiryText, statusClass } = formatExpiryLabel(lot.expiry_date);
  const step = isContinuousUnit(item.unit) ? 100 : 1;

  return `
    <div class="lot-row">
      <div class="lot-info">
        <span class="lot-expiry ${statusClass === "expired" ? "text-danger" : statusClass === "soon" ? "text-warning" : ""}">${expiryText}</span>
      </div>
      <div class="qty-control">
        <button class="qty-btn" data-action="adjust-lot-qty" data-lot-id="${lot.id}" data-item-id="${item.id}" data-current-qty="${lot.quantity}" data-delta="-${step}" aria-label="減らす"><span class="material-symbols-rounded">remove</span></button>
        <span class="qty-num" data-action="edit-lot-qty" data-lot-id="${lot.id}" data-item-id="${item.id}" data-qty="${lot.quantity}" data-unit="${escapeHtml(item.unit)}">${lot.quantity}<span class="qty-unit">${escapeHtml(item.unit)}</span></span>
        <button class="qty-btn" data-action="adjust-lot-qty" data-lot-id="${lot.id}" data-item-id="${item.id}" data-current-qty="${lot.quantity}" data-delta="${step}" aria-label="増やす"><span class="material-symbols-rounded">add</span></button>
      </div>
    </div>
  `;
}

// 商品マスタが無い商品向けの、従来どおりの単一商品カード(表示が壊れないフォールバック)
function itemCardHtml(item) {
  const lots = sortLotsByExpiry(item.item_lots);
  const totalQuantity = lots.reduce((sum, l) => sum + Number(l.quantity), 0);
  const lowStock = totalQuantity <= Number(item.low_stock_threshold);

  // カード全体の期限ステータスは、もっとも緊急度が高いロットに合わせる
  let cardStatusClass = "";
  for (const lot of lots) {
    const d = daysUntil(lot.expiry_date);
    if (d !== null && d < 0) { cardStatusClass = "expired"; break; }
    if (d !== null && d <= 3) cardStatusClass = "soon";
  }

  const lotsHtml = lots.length
    ? lots.map(lot => lotRowHtml(item, lot)).join("")
    : '<div class="empty-note">在庫がありません。</div>';

  return `
    <div class="item-card ${cardStatusClass}">
      <div class="item-card-header">
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-badges">
          ${lowStock ? '<span class="tag warning">在庫少なめ</span>' : ""}
          <button type="button" class="detail-btn" data-action="view-product-detail" data-mode="fallback"
            data-item-id="${item.id}" data-item-name="${escapeHtml(item.name)}"
            data-low-stock-threshold="${item.low_stock_threshold}" data-unit="${escapeHtml(item.unit)}" aria-label="商品の詳細">
            <span class="material-symbols-rounded">info</span>
          </button>
        </div>
      </div>
      <div class="lot-list">
        ${lotsHtml}
      </div>
    </div>
  `;
}

// 標準商品名(product_master)ごとにまとめたカード。
// 見出しに標準商品名だけを表示し、その下に実際の商品名(items.name)ごとの区画を並べる。
// 商品属性・最低数量は標準商品名(カード)単位の操作のため見出し側に⚙️ボタンを置き、
// 購入日・削除は商品名(items.id)単位の操作のため各区画(子)側にⓘボタンを置く。
function masterGroupCardHtml(group) {
  if (group.length === 1 && !group[0].product_master_id) {
    return itemCardHtml(group[0]);
  }

  // カード全体の枠線色は、グループ内すべてのロットの中でもっとも緊急度が高いものに合わせる
  let cardStatusClass = "";
  group.forEach(item => {
    (item.item_lots || []).forEach(lot => {
      const d = daysUntil(lot.expiry_date);
      if (d !== null && d < 0) cardStatusClass = "expired";
      else if (d !== null && d <= 3 && cardStatusClass !== "expired") cardStatusClass = "soon";
    });
  });

  const canonicalName = (group[0].product_master && group[0].product_master.canonical_name) || group[0].name;

  // 最低数量は標準商品名(カード)単位。個数系・定量系が混在する場合は
  // computeCombinedStockQuantity で定量換算してから合算し、product_master.low_stock_threshold と比較する
  const entries = group.map(item => ({
    quantity: (item.item_lots || []).reduce((sum, l) => sum + Number(l.quantity), 0),
    unit: item.unit
  }));
  const combinedQuantity = computeCombinedStockQuantity(entries);
  const masterThreshold = Number(group[0].product_master && group[0].product_master.low_stock_threshold) || 0;
  const cardLowStock = masterThreshold > 0 && combinedQuantity < masterThreshold;
  const thresholdUnit = representativeUnitForEntries(entries);

  return `
    <div class="item-card ${cardStatusClass}">
      <div class="item-card-header">
        <div class="item-name">${escapeHtml(canonicalName)}</div>
        <span class="item-badges">
          ${cardLowStock ? '<span class="tag warning">在庫少なめ</span>' : ""}
          <button type="button" class="detail-btn" data-action="view-product-detail" data-mode="master"
            data-product-master-id="${group[0].product_master_id}" data-threshold-unit="${escapeHtml(thresholdUnit)}" aria-label="商品属性の詳細">
            <span class="material-symbols-rounded">settings</span>
          </button>
        </span>
      </div>
      ${group.map(item => itemSubgroupHtml(item)).join("")}
    </div>
  `;
}

function itemSubgroupHtml(item) {
  const lots = sortLotsByExpiry(item.item_lots);

  const lotsHtml = lots.length
    ? lots.map(lot => lotRowHtml(item, lot)).join("")
    : '<div class="empty-note">在庫がありません。</div>';

  return `
    <div class="item-subgroup">
      <div class="item-subgroup-header">
        <span class="item-subname">${escapeHtml(item.name)}</span>
        <span class="item-badges">
          <button type="button" class="detail-btn" data-action="view-product-detail" data-mode="item"
            data-item-id="${item.id}" data-item-name="${escapeHtml(item.name)}" data-unit="${escapeHtml(item.unit)}" aria-label="購入日・削除">
            <span class="material-symbols-rounded">info</span>
          </button>
        </span>
      </div>
      <div class="lot-list">
        ${lotsHtml}
      </div>
    </div>
  `;
}

document.getElementById("add-item-btn").addEventListener("click", async () => {
  const name = document.getElementById("item-name").value.trim();
  const unit = document.getElementById("item-unit").value.trim() || "個";
  const quantity = manualQuantityValue;
  const expiry = document.getElementById("item-expiry").value || null;
  const price = computeStoredUnitPrice(document.getElementById("item-price").value, priceMode, unit, quantity);
  const typeFallback = document.getElementById("item-type-fallback");
  const category = typeFallback.classList.contains("hidden") ? undefined : document.getElementById("item-type").value;

  if (!name) {
    showMessage(manualAddMessageBox, "商品名を入力してください", true);
    return;
  }

  const result = await upsertItemByName({
    name, category, unit, quantity, expiry_date: expiry, price
  });

  if (result && result.needsCategory) {
    typeFallback.classList.remove("hidden");
    showMessage(manualAddMessageBox, "商品属性を自動判定できませんでした。種別を選択してもう一度「登録」を押してください", true);
    return;
  }

  if (!result) {
    showMessage(manualAddMessageBox, "登録に失敗しました。もう一度お試しください。", true);
    return;
  }

  const message = productMasterStatusPrefix(result.productMasterStatus) + "登録しました(同じ商品・同じ賞味期限があれば数量をまとめました)";
  showMessage(manualAddMessageBox, message, false);
  showAppNotice(message);

  // 買い物リスト「購入済み」からの登録であれば、対象の買い物リスト行を削除して一覧を更新する
  if (purchaseShoppingId) {
    await supabaseClient.from("shopping_list").delete().eq("id", purchaseShoppingId);
    loadShoppingList();
  }

  resetManualRegisterForm();
});

// 「買い物リストに追加」: 在庫ロットは作成・変更せず、商品名だけを買い物リストへ追加する
document.getElementById("add-to-shopping-manual-btn").addEventListener("click", async () => {
  const name = document.getElementById("item-name").value.trim();

  if (!name) {
    showMessage(manualAddMessageBox, "商品名を入力してください", true);
    return;
  }

  const result = await addToShoppingList(name);

  if (!result.ok) {
    showMessage(manualAddMessageBox, "買い物リストへの追加に失敗しました。もう一度お試しください。", true);
    return;
  }

  const message = result.duplicate ? `「${name}」はすでに買い物リストにあります` : `「${name}」を買い物リストに追加しました`;
  showMessage(manualAddMessageBox, message, false);
  showAppNotice(message);
  resetManualRegisterForm();
});

// ロットの数量を指定した値に確定する。0以下になったロットは削除する(他のロットには影響しない)
// 消費画面(js/consume.js)からも、ロット単位で指定した消費数量を直接反映するために再利用する。
// previousQty(変更前の数量)は呼び出し元(画面に表示中の値)から受け取り、それとの差分を
// 購入・消費履歴(item_history)へ記録する(増えれば購入、減れば消費)。呼び出し元が把握して
// いる値をそのまま使うことで、再取得(RLS等の影響を受けうる)に依存しない
export async function persistLotQty(lotId, itemId, newQty, previousQty) {
  const clamped = Math.max(0, newQty);
  const oldQty = Number(previousQty) || 0;
  const delta = clamped - oldQty;

  const { data: currentLot } = await supabaseClient.from("item_lots").select("price").eq("id", lotId).maybeSingle();

  if (clamped <= 0) {
    const { error } = await supabaseClient.from("item_lots").delete().eq("id", lotId);
    if (error) { console.error("ロットの削除に失敗:", error); return; }
  } else {
    const { error } = await supabaseClient
      .from("item_lots")
      .update({ quantity: clamped, updated_at: new Date().toISOString() })
      .eq("id", lotId);
    if (error) { console.error("ロットの数量更新に失敗:", error); return; }
  }

  const lotPrice = currentLot ? currentLot.price : null;
  if (delta > 0) await logItemHistory(itemId, "purchase", delta, lotPrice);
  else if (delta < 0) await logItemHistory(itemId, "consumption", -delta, lotPrice);

  await syncShoppingListForItem(itemId);
  loadItems();
}

// ロット単位の数量増減([-][+]ボタン)
async function adjustLotQty(lotId, itemId, currentQty, delta) {
  await persistLotQty(lotId, itemId, Number(currentQty) + delta, currentQty);
}

// カード内のボタンはloadItems()のたびに再生成されるため、itemListElへの委譲で拾う
itemListEl.addEventListener("click", (e) => {
  const qtyBtn = e.target.closest('[data-action="adjust-lot-qty"]');
  if (qtyBtn) {
    adjustLotQty(qtyBtn.dataset.lotId, qtyBtn.dataset.itemId, Number(qtyBtn.dataset.currentQty), Number(qtyBtn.dataset.delta));
    return;
  }

  const qtyNum = e.target.closest('[data-action="edit-lot-qty"]');
  if (qtyNum) {
    openQuantityPicker({
      initialValue: Number(qtyNum.dataset.qty),
      unit: qtyNum.dataset.unit,
      title: "在庫数を設定",
      onConfirm: (value) => persistLotQty(qtyNum.dataset.lotId, qtyNum.dataset.itemId, value, qtyNum.dataset.qty)
    });
  }
});

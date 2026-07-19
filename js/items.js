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
import { isContinuousUnit } from "./quantity.js";
import { openQuantityPicker } from "./quantityPicker.js";
import { resolveProductMaster } from "./productMaster.js";
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
});
renderManualQuantityQuickAdjustLabels();

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

  loadNameSuggestionPool();
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

async function loadNameSuggestionPool() {
  const [{ data: itemRows }, { data: masterRows }] = await Promise.all([
    supabaseClient.from("items").select("name"),
    supabaseClient.from("product_master").select("canonical_name, canonical_name_reading")
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
    pool.push({ text: name, reading: row.canonical_name_reading || "", isCanonical: true });
  });

  nameSuggestionPool = pool;
}

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
}

// 標準商品名の候補は、文字の開始位置がずれて読みにくくならないよう、
// バッジ「標準」をテキストの右端に小さく表示する。先頭の「・」は検索アイコンの代わりの
// 目印(このアプリでは「検索」ではなく「候補の提示」なので、機能を連想させない記号にしている)
function renderNameSuggestions(term) {
  const suggestionsEl = document.getElementById("item-name-suggestions");
  const matches = term ? filterNameSuggestions(term) : [];

  if (matches.length === 0) {
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
  // 商品名候補を選んだ直後で値が変わっていなければ予測は表示しない
  // (標準商品名を選んだ場合はlastSelectedSuggestionValueを記録していないため、ここには来ない)
  if (value && value === lastSelectedSuggestionValue) {
    setNameSuggestionsVisible(false);
    return;
  }
  lastSelectedSuggestionValue = null;
  renderNameSuggestions(value);
});

itemNameInput.addEventListener("focus", () => {
  clearTimeout(suggestionsHideTimer);
  const value = itemNameInput.value.trim();
  if (value && value !== lastSelectedSuggestionValue) renderNameSuggestions(value);
});

// クリックより先にblurが発火して候補が消えてしまわないよう、mousedownの時点で確定させる
itemNameSuggestionsEl.addEventListener("mousedown", (e) => {
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
  // 単位の自動推定・予測欄の表示更新など、既存のinputリスナーに反映させる
  itemNameInput.dispatchEvent(new Event("input", { bubbles: true }));
});

itemNameInput.addEventListener("blur", () => {
  suggestionsHideTimer = setTimeout(() => setNameSuggestionsVisible(false), 150);
});

const filterCategorySelect = document.getElementById("filter-category");

filterCategorySelect.addEventListener("change", () => loadItems());
document.getElementById("filter-subcategory").addEventListener("change", () => loadItems());

// 商品(items)を解決する。既存商品があればそのid、なければ新規作成してidを返す。
// category未指定の新規商品は、まず商品マスタ(AI)から種別(食品/日用品)を判定して
// items.categoryへ自動反映する。商品マスタの判定に失敗した場合は登録せず、
// needsCategory:true を返して呼び出し元に種別の手入力を促す(AIの再呼び出しはしない)。
// productMasterStatus: 商品マスタ解決が行われた場合のみ "generated"(AIが新規生成)
// または "reused"(既存の商品属性を利用)。既存商品名にヒットした場合・種別を手入力した
// 場合(商品マスタ解決自体が行われない)は null。呼び出し元の登録完了メッセージで使う。
async function resolveItem({ name, category, unit }) {
  const cleanName = (name || "").trim();
  if (!cleanName) return { itemId: null, needsCategory: false, productMasterStatus: null };

  const { data: existingList, error: findError } = await supabaseClient
    .from("items")
    .select("id")
    .eq("name", cleanName)
    .limit(1);

  if (findError) { console.error("既存商品の検索に失敗:", findError); return { itemId: null, needsCategory: false, productMasterStatus: null }; }

  if (existingList && existingList.length > 0) {
    return { itemId: existingList[0].id, needsCategory: false, productMasterStatus: null };
  }

  let resolvedCategory = category;
  let productMasterId = null;
  let productMasterStatus = null;

  if (!resolvedCategory) {
    const resolved = await resolveProductMaster(cleanName);
    if (!resolved) return { itemId: null, needsCategory: true, productMasterStatus: null };
    resolvedCategory = resolved.master.type;
    productMasterId = resolved.master.id;
    productMasterStatus = resolved.generatedNew ? "generated" : "reused";
  }

  const { data: inserted, error: insertError } = await supabaseClient
    .from("items")
    .insert({
      name: cleanName,
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

// 商品(itemId)に対して、同じ賞味期限(未設定同士も含む)のロットがあれば数量を加算、
// なければ新しいロットを作成する。賞味期限が異なる場合は必ず新規ロットになる。
// (買い物リストからの在庫登録など、既存商品にロットだけ追加したい他の処理からも再利用する)
export async function resolveLot(itemId, quantity, expiryDate) {
  let findQuery = supabaseClient.from("item_lots").select("id, quantity").eq("item_id", itemId);
  findQuery = expiryDate ? findQuery.eq("expiry_date", expiryDate) : findQuery.is("expiry_date", null);
  const { data: existingList, error: findError } = await findQuery.limit(1);

  if (findError) { console.error("既存ロットの検索に失敗:", findError); return null; }

  const existing = existingList && existingList.length > 0 ? existingList[0] : null;

  if (existing) {
    const newQuantity = Number(existing.quantity) + Number(quantity || 0);
    const { error: updateError } = await supabaseClient
      .from("item_lots")
      .update({ quantity: newQuantity, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (updateError) { console.error("ロットの更新に失敗:", updateError); return null; }
    return existing.id;
  } else {
    const { error: insertError } = await supabaseClient
      .from("item_lots")
      .insert({
        item_id: itemId,
        quantity: Number(quantity || 0),
        expiry_date: expiryDate || null
      });
    if (insertError) { console.error("ロットの登録に失敗:", insertError); return null; }
    return true;
  }
}

// 商品を登録する(商品の解決 + ロットの解決をまとめた、既存呼び出し元向けの入口)。
// AI写真登録・手動登録のすべてがこの関数を経由する。
// 戻り値: 成功時は { itemId, productMasterStatus }、失敗時はnull、商品マスタの自動判定に
// 失敗し種別の手入力が必要な場合は { needsCategory: true }(呼び出し元はcategoryを付けて再実行する)
export async function upsertItemByName({ name, category, unit, quantity, expiry_date }) {
  const { itemId, needsCategory, productMasterStatus } = await resolveItem({ name, category, unit });
  if (needsCategory) return { needsCategory: true };
  if (!itemId) return null;

  const lotResult = await resolveLot(itemId, quantity, expiry_date);
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

export async function loadItems() {
  const { data, error } = await supabaseClient
    .from("items")
    .select("*, item_lots(*), product_master(canonical_name, category, sub_category)")
    .order("name", { ascending: true });

  if (error) {
    itemListEl.innerHTML = '<div class="empty-note">読み込みエラー: ' + error.message + '</div>';
    return;
  }

  const allItems = data || [];
  const categoryFilter = filterCategorySelect.value;
  const subcategoryFilter = document.getElementById("filter-subcategory").value;

  // カテゴリー/サブカテゴリーとも固定リストが無いため、選択肢は実データから動的に作る(サブカテゴリーはカテゴリー絞り込みに応じたカスケード)
  updateCategoryFilterOptions(allItems);
  updateSubcategoryFilterOptions(allItems, categoryFilter);

  const filtered = allItems.filter(item => {
    if (categoryFilter && effectiveCategory(item) !== categoryFilter) return false;
    if (subcategoryFilter && effectiveSubCategory(item) !== subcategoryFilter) return false;
    return true;
  });

  renderItems(filtered);
}

function updateCategoryFilterOptions(allItems) {
  const select = filterCategorySelect;
  const previousValue = select.value;

  const categories = Array.from(new Set(
    allItems.map(item => effectiveCategory(item)).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b, "ja"));

  select.innerHTML = '<option value="">すべてのカテゴリー</option>' +
    categories.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join("");

  if (categories.includes(previousValue)) select.value = previousValue;
}

function updateSubcategoryFilterOptions(allItems, categoryFilter) {
  const select = document.getElementById("filter-subcategory");
  const previousValue = select.value;

  const relevant = categoryFilter
    ? allItems.filter(item => effectiveCategory(item) === categoryFilter)
    : allItems;

  const subCategories = Array.from(new Set(
    relevant.map(item => effectiveSubCategory(item)).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b, "ja"));

  select.innerHTML = '<option value="">すべてのサブカテゴリー</option>' +
    subCategories.map(sub => `<option value="${escapeHtml(sub)}">${escapeHtml(sub)}</option>`).join("");

  if (subCategories.includes(previousValue)) select.value = previousValue;
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

  // 商品一覧は「もっとも賞味期限が近いロット」を基準に並べる(未設定は最後)
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

  const buckets = {};
  masterGroups.forEach(group => {
    const category = effectiveCategory(group[0]);
    const subCategory = effectiveSubCategory(group[0]) || "未分類";
    buckets[category] = buckets[category] || {};
    buckets[category][subCategory] = buckets[category][subCategory] || [];
    buckets[category][subCategory].push(group);
  });

  let html = "";
  Object.keys(buckets).sort().forEach(category => {
    html += `<h3 class="group-heading">${escapeHtml(category)}</h3>`;
    Object.keys(buckets[category]).sort().forEach(subCategory => {
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
          <button type="button" class="detail-btn" data-action="view-product-detail"
            data-item-id="${item.id}" data-item-name="${escapeHtml(item.name)}"
            data-product-master-id="${item.product_master_id || ""}"
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
// 商品詳細・最低数量・削除は items.id 単位の操作のため、詳細ボタンは各区画(子)側に置く。
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

  return `
    <div class="item-card ${cardStatusClass}">
      <div class="item-card-header">
        <div class="item-name">${escapeHtml(canonicalName)}</div>
      </div>
      ${group.map(item => itemSubgroupHtml(item)).join("")}
    </div>
  `;
}

function itemSubgroupHtml(item) {
  const lots = sortLotsByExpiry(item.item_lots);
  const totalQuantity = lots.reduce((sum, l) => sum + Number(l.quantity), 0);
  const lowStock = totalQuantity <= Number(item.low_stock_threshold);

  const lotsHtml = lots.length
    ? lots.map(lot => lotRowHtml(item, lot)).join("")
    : '<div class="empty-note">在庫がありません。</div>';

  return `
    <div class="item-subgroup">
      <div class="item-subgroup-header">
        <span class="item-subname">${escapeHtml(item.name)}</span>
        <span class="item-badges">
          ${lowStock ? '<span class="tag warning">在庫少なめ</span>' : ""}
          <button type="button" class="detail-btn" data-action="view-product-detail"
            data-item-id="${item.id}" data-item-name="${escapeHtml(item.name)}"
            data-product-master-id="${item.product_master_id || ""}"
            data-low-stock-threshold="${item.low_stock_threshold}" data-unit="${escapeHtml(item.unit)}" aria-label="商品の詳細">
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
  const typeFallback = document.getElementById("item-type-fallback");
  const category = typeFallback.classList.contains("hidden") ? undefined : document.getElementById("item-type").value;

  if (!name) {
    showMessage(manualAddMessageBox, "商品名を入力してください", true);
    return;
  }

  const result = await upsertItemByName({
    name, category, unit, quantity, expiry_date: expiry
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
// 消費画面(js/consume.js)からも、ロット単位で指定した消費数量を直接反映するために再利用する
export async function persistLotQty(lotId, itemId, newQty) {
  const clamped = Math.max(0, newQty);

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

  await syncShoppingListForItem(itemId);
  loadItems();
}

// ロット単位の数量増減([-][+]ボタン)
async function adjustLotQty(lotId, itemId, currentQty, delta) {
  await persistLotQty(lotId, itemId, Number(currentQty) + delta);
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
      onConfirm: (value) => persistLotQty(qtyNum.dataset.lotId, qtyNum.dataset.itemId, value)
    });
  }
});

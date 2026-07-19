// ==========================================================
// 商品マスタ 詳細/編集シート
//
// 在庫一覧の「詳細」ボタン(data-action="view-product-detail")から開く。
// 表示内容は product_master から取得し、編集の保存は updateProductMasterFields()
// で product_master を直接更新する(AIへの再問い合わせは行わない)。
//
// product_master_id が未設定の商品は「商品属性を作成」ボタンを表示し、
// resolveProductMaster(name, { forceRegenerate: true }) で新規作成する。
// forceRegenerate は将来「既存の商品属性を再生成する」機能(AIモデル変更時・
// 分類ルール改善時など)にもそのまま流用できる共通の入口として設計している。
// ==========================================================

import { supabaseClient } from "./config.js";
import { escapeHtml, showAppNotice } from "./utils.js";
import {
  resolveProductMaster,
  updateProductMasterFields,
  getCategoryIcon,
  isHiragana,
  FOOD_CATEGORIES,
  DAILY_CATEGORIES,
  FOOD_STORAGE_OPTIONS,
  DAILY_STORAGE_OPTIONS,
  FOOD_USAGE_OPTIONS,
  DAILY_USAGE_OPTIONS
} from "./productMaster.js";
import { loadItems } from "./items.js";
import { syncShoppingListForItem, loadShoppingList } from "./shopping.js";
import { isContinuousUnit } from "./quantity.js";
import { openQuantityPicker } from "./quantityPicker.js";

function show(id) {
  const el = document.getElementById(id);
  if (el.classList.contains("hidden")) el.classList.remove("hidden");
}
function hide(id) {
  const el = document.getElementById(id);
  if (!el.classList.contains("hidden")) el.classList.add("hidden");
}

let currentItem = null;   // { id, name }
let currentMaster = null; // product_master 行 (未作成なら null)
let editKeywords = [];

// ---------- トースト(汎用) ----------

let toastTimer = null;
function showToast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2000);
}

// ---------- 表示モード ----------

function applyBadge(elId, field) {
  const el = document.getElementById(elId);
  const edited = !!currentMaster.edited_fields?.includes(field);
  el.className = "product-detail-source-badge " + (edited ? "manual" : "ai");
  el.textContent = edited ? "👤 あなたが変更" : "🤖 AIが設定";
}

function renderView() {
  hide("product-detail-loading");
  hide("product-detail-empty");
  hide("product-detail-edit");
  show("product-detail-view");

  const icon = currentMaster.icon || getCategoryIcon(currentMaster.type, currentMaster.category);
  document.getElementById("pd-icon").textContent = icon;
  document.getElementById("pd-icon-value").textContent = icon;
  document.getElementById("pd-item-name").textContent = currentItem.name;
  document.getElementById("pd-canonical-name").textContent = "標準商品名: " + currentMaster.canonical_name;
  document.getElementById("pd-canonical-reading").textContent = currentMaster.canonical_name_reading || "読み方未登録";
  hide("pd-canonical-reading"); // 商品を切り替えるたびに閉じた状態に戻す
  document.getElementById("pd-type").textContent = currentMaster.type;
  document.getElementById("pd-category").textContent = currentMaster.category;
  document.getElementById("pd-sub-category").textContent = currentMaster.sub_category || "未設定";
  document.getElementById("pd-storage").textContent = currentMaster.storage || "未設定";
  document.getElementById("pd-usage").textContent = currentMaster.usage || "未設定";

  applyBadge("pd-icon-badge", "icon");
  applyBadge("pd-category-badge", "category");
  applyBadge("pd-sub-category-badge", "subCategory");
  applyBadge("pd-storage-badge", "storage");
  applyBadge("pd-usage-badge", "usage");
  applyBadge("pd-keywords-badge", "searchKeywords");

  const keywords = currentMaster.search_keywords || [];
  document.getElementById("pd-keywords").innerHTML = keywords.length
    ? keywords.map(k => `<span class="product-detail-keyword-chip">${escapeHtml(k)}</span>`).join("")
    : '<span class="product-detail-attr-value" style="color:var(--text-tertiary);">未設定</span>';
}

// 標準商品名をタップすると、登録済みのひらがな読みを表示/非表示する
document.getElementById("pd-canonical-name").addEventListener("click", () => {
  document.getElementById("pd-canonical-reading").classList.toggle("hidden");
});

// ---------- 編集モード ----------

function populateSelect(selectEl, options, selectedValue) {
  selectEl.innerHTML = options.map(o =>
    `<option value="${escapeHtml(o)}" ${o === selectedValue ? "selected" : ""}>${escapeHtml(o)}</option>`
  ).join("");
  if (!options.includes(selectedValue)) selectEl.value = options[0];
}

function renderEditKeywords() {
  document.getElementById("pd-edit-keywords").innerHTML = editKeywords.map((k, i) => `
    <span class="product-detail-keyword-chip">
      ${escapeHtml(k)} <span class="remove" data-remove-index="${i}">✕</span>
    </span>
  `).join("");
}

function renderEdit() {
  hide("product-detail-view");
  show("product-detail-edit");

  document.getElementById("pd-edit-canonical-name").value = currentMaster.canonical_name || "";
  document.getElementById("pd-edit-canonical-name-reading").value = currentMaster.canonical_name_reading || "";
  hide("pd-edit-canonical-reading-error");

  document.getElementById("pd-edit-icon").value =
    currentMaster.icon || getCategoryIcon(currentMaster.type, currentMaster.category);

  const isFood = currentMaster.type === "食品";
  populateSelect(document.getElementById("pd-edit-category"), isFood ? FOOD_CATEGORIES : DAILY_CATEGORIES, currentMaster.category);
  populateSelect(document.getElementById("pd-edit-storage"), isFood ? FOOD_STORAGE_OPTIONS : DAILY_STORAGE_OPTIONS, currentMaster.storage);
  populateSelect(document.getElementById("pd-edit-usage"), isFood ? FOOD_USAGE_OPTIONS : DAILY_USAGE_OPTIONS, currentMaster.usage);

  document.getElementById("pd-edit-sub-category").value = currentMaster.sub_category || "";

  editKeywords = [...(currentMaster.search_keywords || [])];
  renderEditKeywords();
  document.getElementById("pd-edit-keyword-input").value = "";

  const msgEl = document.getElementById("product-detail-save-message");
  msgEl.textContent = "";
  msgEl.className = "";
}

document.getElementById("pd-edit-keywords").addEventListener("click", (e) => {
  const removeEl = e.target.closest("[data-remove-index]");
  if (!removeEl) return;
  editKeywords.splice(Number(removeEl.dataset.removeIndex), 1);
  renderEditKeywords();
});

document.getElementById("pd-edit-keyword-add-btn").addEventListener("click", () => {
  const input = document.getElementById("pd-edit-keyword-input");
  const value = input.value.trim();
  if (value && !editKeywords.includes(value)) {
    editKeywords.push(value);
    renderEditKeywords();
  }
  input.value = "";
});

document.getElementById("product-detail-edit-btn").addEventListener("click", renderEdit);
document.getElementById("product-detail-cancel-btn").addEventListener("click", renderView);

document.getElementById("product-detail-save-btn").addEventListener("click", async () => {
  if (!currentMaster) return;
  const masterId = currentMaster.id;
  const newCanonicalName = document.getElementById("pd-edit-canonical-name").value.trim();
  const newCanonicalNameReading = document.getElementById("pd-edit-canonical-name-reading").value.trim();
  const newIcon = document.getElementById("pd-edit-icon").value.trim();
  const newCategory = document.getElementById("pd-edit-category").value;
  const newSubCategory = document.getElementById("pd-edit-sub-category").value.trim();
  const newStorage = document.getElementById("pd-edit-storage").value;
  const newUsage = document.getElementById("pd-edit-usage").value;

  const readingErrorEl = document.getElementById("pd-edit-canonical-reading-error");
  if (!newCanonicalName) {
    readingErrorEl.textContent = "標準商品名を入力してください";
    readingErrorEl.classList.remove("hidden");
    return;
  }
  if (!isHiragana(newCanonicalNameReading)) {
    readingErrorEl.textContent = "ひらがなの読み方を入力してください(ひらがなのみ・必須)";
    readingErrorEl.classList.remove("hidden");
    return;
  }
  readingErrorEl.classList.add("hidden");

  const oldIcon = currentMaster.icon || getCategoryIcon(currentMaster.type, currentMaster.category);
  const changes = {};
  if (newCanonicalName !== currentMaster.canonical_name) changes.canonicalName = newCanonicalName;
  if (newCanonicalNameReading !== (currentMaster.canonical_name_reading || "")) changes.canonicalNameReading = newCanonicalNameReading;
  if (newIcon !== oldIcon) changes.icon = newIcon;
  if (newCategory !== currentMaster.category) changes.category = newCategory;
  if (newSubCategory !== (currentMaster.sub_category || "")) changes.subCategory = newSubCategory;
  if (newStorage !== (currentMaster.storage || "")) changes.storage = newStorage;
  if (newUsage !== (currentMaster.usage || "")) changes.usage = newUsage;
  if (JSON.stringify(editKeywords) !== JSON.stringify(currentMaster.search_keywords || [])) {
    changes.searchKeywords = editKeywords;
  }

  if (Object.keys(changes).length === 0) {
    renderView();
    return;
  }

  const saveBtn = document.getElementById("product-detail-save-btn");
  const msgEl = document.getElementById("product-detail-save-message");
  saveBtn.disabled = true;

  const updated = await updateProductMasterFields(masterId, changes);

  saveBtn.disabled = false;

  if (!updated) {
    msgEl.textContent = "保存に失敗しました。もう一度お試しください。";
    msgEl.className = "msg-error";
    return;
  }

  // 保存待ちの間にシートが閉じられた/別の商品に切り替わっていたら、表示の更新はしない
  if (!currentMaster || currentMaster.id !== masterId) return;

  currentMaster = updated;
  renderView();
  showToast("保存しました");
});

// ---------- 開閉 ----------

async function openProductDetail(itemId, itemName, productMasterId, lowStockThreshold, unit) {
  currentItem = { id: itemId, name: itemName, lowStockThreshold: Number(lowStockThreshold) || 0, unit: unit || "" };
  currentMaster = null;

  show("product-detail-overlay");
  hide("product-detail-view");
  hide("product-detail-edit");
  hide("product-detail-loading");
  hide("product-detail-empty");
  document.getElementById("product-detail-create-message").textContent = "";
  renderThresholdDisplay();

  if (!productMasterId) {
    show("product-detail-empty");
    return;
  }

  const { data: master, error } = await supabaseClient
    .from("product_master")
    .select("*")
    .eq("id", productMasterId)
    .maybeSingle();

  // 取得待ちの間に閉じられた/別の商品の詳細に切り替わっていたら、表示の更新はしない
  if (!currentItem || currentItem.id !== itemId) return;

  if (error || !master) {
    show("product-detail-empty");
    return;
  }

  currentMaster = master;
  renderView();
}

function closeProductDetail() {
  hide("product-detail-overlay");
  currentItem = null;
  currentMaster = null;
}

document.getElementById("product-detail-close-btn").addEventListener("click", closeProductDetail);
document.getElementById("product-detail-overlay").addEventListener("click", (e) => {
  if (e.target.id === "product-detail-overlay") closeProductDetail();
});

// 在庫一覧の「詳細」ボタンから開く(カードは loadItems() のたびに再生成されるため委譲で拾う)
document.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="view-product-detail"]');
  if (!btn) return;
  openProductDetail(btn.dataset.itemId, btn.dataset.itemName, btn.dataset.productMasterId || null, btn.dataset.lowStockThreshold, btn.dataset.unit);
});

// ---------- 在庫設定(最低数量) ----------
// 在庫確認画面の数量増減([-][+]・タップでドラムロール)と同じ操作感にしている。
// 増減幅は単位が個数系か定量系(g/mlなど)かで変える(在庫の数量調整と同じ判定)

function renderThresholdDisplay() {
  document.getElementById("pd-threshold-display").innerHTML =
    `${currentItem.lowStockThreshold}<span class="qty-unit">${escapeHtml(currentItem.unit)}</span>`;
}

function thresholdStep() {
  return isContinuousUnit(currentItem && currentItem.unit) ? 100 : 1;
}

async function persistThreshold(newValue) {
  if (!currentItem) return;
  const itemId = currentItem.id;
  const value = Math.max(0, Math.min(9999, Math.round(newValue) || 0));

  const { error } = await supabaseClient
    .from("items")
    .update({ low_stock_threshold: value, updated_at: new Date().toISOString() })
    .eq("id", itemId);
  if (error) {
    console.error("最低数量の更新に失敗:", error);
    return;
  }
  await syncShoppingListForItem(itemId);

  // 更新待ちの間に閉じられた/別の商品に切り替わっていたら、表示の更新はしない
  if (!currentItem || currentItem.id !== itemId) return;
  currentItem.lowStockThreshold = value;
  renderThresholdDisplay();
  showToast("最低数量を更新しました");
}

document.getElementById("pd-threshold-minus").addEventListener("click", () => {
  if (!currentItem) return;
  persistThreshold(currentItem.lowStockThreshold - thresholdStep());
});
document.getElementById("pd-threshold-plus").addEventListener("click", () => {
  if (!currentItem) return;
  persistThreshold(currentItem.lowStockThreshold + thresholdStep());
});
document.getElementById("pd-threshold-display").addEventListener("click", () => {
  if (!currentItem) return;
  openQuantityPicker({
    initialValue: currentItem.lowStockThreshold,
    unit: currentItem.unit,
    title: "最低数量を設定",
    onConfirm: (value) => persistThreshold(value)
  });
});

// ---------- 商品の削除(在庫の全ロットも一緒に削除される) ----------

document.getElementById("product-detail-delete-btn").addEventListener("click", async () => {
  if (!currentItem) return;
  if (!confirm("この商品を削除しますか?登録されている在庫(すべてのロット)も削除されます。")) return;

  const { error } = await supabaseClient.from("items").delete().eq("id", currentItem.id);
  if (error) {
    console.error("商品の削除に失敗:", error);
    return;
  }
  closeProductDetail();
  loadItems();
  loadShoppingList();
});

// ---------- 商品属性の作成(将来、再生成にも流用する共通処理) ----------

async function createOrRegenerateProductMaster(itemId, itemName) {
  const createMsgEl = document.getElementById("product-detail-create-message");
  createMsgEl.textContent = "";
  hide("product-detail-empty");
  show("product-detail-loading");

  const resolved = await resolveProductMaster(itemName, { forceRegenerate: true });

  // 生成待ちの間に閉じられた/別の商品の詳細に切り替わっていたら、表示の更新はしない
  // (在庫一覧側の更新(loadItems)だけは、閉じられていても反映して問題ない)
  if (!resolved) {
    if (currentItem && currentItem.id === itemId) {
      hide("product-detail-loading");
      show("product-detail-empty");
      createMsgEl.textContent = "商品属性の作成に失敗しました。もう一度お試しください。";
      createMsgEl.className = "msg-error";
    }
    return;
  }

  const { master, generatedNew } = resolved;

  const { error: updateError } = await supabaseClient
    .from("items")
    .update({ product_master_id: master.id, updated_at: new Date().toISOString() })
    .eq("id", itemId);
  if (updateError) console.error("items.product_master_id の更新に失敗:", updateError);

  if (currentItem && currentItem.id === itemId) {
    currentMaster = master;
    renderView();
  }
  showAppNotice(generatedNew ? "AIが商品属性を生成しました" : "既存の商品属性を利用しました");
  loadItems(); // 在庫一覧側の表示も最新化する
}

document.getElementById("product-detail-create-btn").addEventListener("click", () => {
  if (!currentItem) return;
  createOrRegenerateProductMaster(currentItem.id, currentItem.name);
});

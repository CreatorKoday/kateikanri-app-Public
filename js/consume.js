// ==========================================================
// 消費登録(写真AI・手動検索、すべてで共用するロジック)
//
// 在庫確認画面と同じ見た目(item-card / lot-list / lot-row)で、
// 商品ごとにロットを個別に表示し、ロットごとに消費数量を指定できるようにしている。
//
// 検索結果が多くなることを見越して、AI・手動どちらの消費確認も
// 共通オーバーレイ(#consume-overlay)の中で完結させている。
// ==========================================================

import { supabaseClient } from "./config.js";
import { addMessageBox, consumeMessageBox } from "./elements.js";
import { showMessage, escapeHtml, withTotalQuantity, showAppNotice } from "./utils.js";
import { loadShoppingList } from "./shopping.js";
import { loadItems, persistLotQty, sortLotsByExpiry, formatExpiryLabel } from "./items.js";
import { fileToBase64, identifyProductsWithAI } from "./aiPhoto.js";
import { isContinuousUnit } from "./quantity.js";
import { openQuantityPicker } from "./quantityPicker.js";
import { getCategoryReading, getCategoryIcon } from "./productMaster.js";

const consumeOverlayEl = document.getElementById("consume-overlay");
const consumeSearchInput = document.getElementById("consume-search");
const consumeSearchResultsEl = document.getElementById("consume-search-results");

function openConsumeOverlay() {
  consumeOverlayEl.classList.remove("hidden");
}
function closeConsumeOverlay() {
  consumeOverlayEl.classList.add("hidden");
  consumeSearchInput.value = "";
  consumeSearchResultsEl.innerHTML = "";
  document.getElementById("consume-review-list").innerHTML = "";
  document.getElementById("consume-review-section").classList.add("hidden");
  consumeMessageBox.textContent = "";
}

// ホーム画面(home.js)の「消費 > 手動」ボタンから呼ばれる入口
export function openConsumeSearchOverlay() {
  openConsumeOverlay();
  consumeSearchInput.focus();
}

document.getElementById("consume-overlay-close-btn").addEventListener("click", closeConsumeOverlay);

// 商品詳細シートと同じく、背景(オーバーレイ自体)をタップしたら閉じる
consumeOverlayEl.addEventListener("click", (e) => {
  if (e.target === consumeOverlayEl) closeConsumeOverlay();
});

// ロット1件分の行。数量欄は「消費後にそのロットに残る数量」を表す
// (初期値はそのロットの現在の数量=何もしなければ何も消費しない)。
// 「1/4」「半分」「すべて」ボタンは、押すとそのロットの残り数量を該当する割合にする
// (「すべて」=すべて消費する、なので残り0)
function consumeLotRowHtml(item, lot) {
  const { text: expiryText, statusClass } = formatExpiryLabel(lot.expiry_date);
  const step = isContinuousUnit(item.unit) ? 100 : 1;
  const qty = Number(lot.quantity);

  return `
    <div class="lot-row consume-lot-row">
      <div class="lot-row-top">
        <div class="lot-info">
          <span class="lot-expiry ${statusClass === "expired" ? "text-danger" : statusClass === "soon" ? "text-warning" : ""}">${expiryText}</span>
        </div>
        <div class="qty-control">
          <button type="button" class="qty-btn" data-action="adjust-consume-lot-qty" data-delta="-${step}" aria-label="減らす"><span class="material-symbols-rounded">remove</span></button>
          <span class="qty-num" data-action="edit-consume-lot-qty" data-lot-id="${lot.id}" data-qty="${qty}" data-original-qty="${qty}" data-unit="${escapeHtml(item.unit)}">${qty}<span class="qty-unit">${escapeHtml(item.unit)}</span></span>
          <button type="button" class="qty-btn" data-action="adjust-consume-lot-qty" data-delta="${step}" aria-label="増やす"><span class="material-symbols-rounded">add</span></button>
        </div>
      </div>
      <div class="consume-fraction-row">
        <button type="button" class="unit-chip" data-fraction="0.25">1/4</button>
        <button type="button" class="unit-chip" data-fraction="0.5">半分</button>
        <button type="button" class="unit-chip" data-fraction="0">すべて</button>
      </div>
    </div>
  `;
}

// 消費対象カードのHTMLを組み立てる(写真AI・手動検索すべてで共用)。在庫確認画面と同じカード見た目にしている
function renderConsumeCardsHtml(items) {
  return items.map(item => {
    const lots = sortLotsByExpiry(item.item_lots);
    const lotsHtml = lots.length
      ? lots.map(lot => consumeLotRowHtml(item, lot)).join("")
      : '<div class="empty-note">在庫がありません。</div>';

    return `
    <div class="item-card consume-card" data-item-id="${item.id}">
      <div class="item-card-header">
        <div class="item-name">${escapeHtml(item.name)}</div>
      </div>
      <p class="review-note">現在の在庫: ${item.quantity}${escapeHtml(item.unit)}</p>
      <div class="lot-list">
        ${lotsHtml}
      </div>
    </div>
  `;
  }).join("");
}

// 消費カードのロット数量表示(qty-num、残り数量)を更新する。
// 残り数量なので、そのロットの元の在庫数量を超えることはない
function updateConsumeLotQtyDisplay(numEl, value) {
  const max = Number(numEl.dataset.originalQty) || 0;
  const clamped = Math.max(0, Math.min(max, value));
  numEl.dataset.qty = clamped;
  numEl.innerHTML = `${clamped}<span class="qty-unit">${escapeHtml(numEl.dataset.unit)}</span>`;
}

// 消費確認リストへ商品を追加し、共通オーバーレイを開く(写真AI・手動検索の共通入口)。
// 既にリストにある商品は重複追加しない
export function showConsumeReview(items) {
  const listEl = document.getElementById("consume-review-list");
  const newItems = items.filter(item => !listEl.querySelector('.consume-card[data-item-id="' + item.id + '"]'));
  if (newItems.length > 0) {
    listEl.insertAdjacentHTML("beforeend", renderConsumeCardsHtml(newItems));
  }
  if (window.lucide) lucide.createIcons();

  const sectionEl = document.getElementById("consume-review-section");
  sectionEl.classList.remove("hidden");
  openConsumeOverlay();
  sectionEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ロットの[-][+]・数量タップ(ドラムロール)・「1/4」「半分」「すべて」ボタン
// (イベント委譲で、後から増えるカードにも対応)
document.addEventListener("click", (e) => {
  const adjustBtn = e.target.closest('[data-action="adjust-consume-lot-qty"]');
  if (adjustBtn) {
    const numEl = adjustBtn.closest(".lot-row").querySelector('[data-action="edit-consume-lot-qty"]');
    updateConsumeLotQtyDisplay(numEl, Number(numEl.dataset.qty) + Number(adjustBtn.dataset.delta));
    return;
  }

  const fractionBtn = e.target.closest("[data-fraction]");
  if (fractionBtn) {
    const numEl = fractionBtn.closest(".lot-row").querySelector('[data-action="edit-consume-lot-qty"]');
    const originalQty = Number(numEl.dataset.originalQty);
    updateConsumeLotQtyDisplay(numEl, Math.round(originalQty * Number(fractionBtn.dataset.fraction)));
    return;
  }

  const qtyNum = e.target.closest('[data-action="edit-consume-lot-qty"]');
  if (qtyNum) {
    openQuantityPicker({
      initialValue: Number(qtyNum.dataset.qty),
      unit: qtyNum.dataset.unit,
      title: "残りの数量",
      onConfirm: (value) => updateConsumeLotQtyDisplay(qtyNum, value)
    });
  }
});

async function confirmConsume() {
  const container = document.getElementById("consume-review-list");
  const cards = container.querySelectorAll(".consume-card");
  if (cards.length === 0) {
    showMessage(consumeMessageBox, "消費する商品がありません", true);
    return;
  }

  let count = 0;
  for (const card of cards) {
    const itemId = card.dataset.itemId;
    const lotNums = card.querySelectorAll('[data-action="edit-consume-lot-qty"]');
    let consumedAny = false;

    for (const numEl of lotNums) {
      const remainingQty = Number(numEl.dataset.qty) || 0;
      const originalQty = Number(numEl.dataset.originalQty) || 0;
      if (remainingQty >= originalQty) continue; // 残り数量が変わっていない = 消費しない
      await persistLotQty(numEl.dataset.lotId, itemId, remainingQty);
      consumedAny = true;
    }

    if (consumedAny) count++;
  }

  const message = count + "件消費しました";
  showMessage(consumeMessageBox, message, false);
  showAppNotice(message);
  container.innerHTML = "";
  document.getElementById("consume-review-section").classList.add("hidden");
  loadItems();
  loadShoppingList();
}

document.getElementById("confirm-consume-btn").addEventListener("click", confirmConsume);

// ---------- 写真AIによる消費登録 ----------

document.getElementById("consume-photo-btn").addEventListener("click", () => {
  document.getElementById("consume-photo-input").click();
});

document.getElementById("consume-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  showAppNotice("AIが商品を判定中です。少々お待ちください...");

  try {
    const base64Data = await fileToBase64(file);
    const detected = await identifyProductsWithAI(base64Data, file.type);

    if (!detected || detected.length === 0) {
      showAppNotice("");
      showMessage(addMessageBox, "商品を判定できませんでした。「手動で消費登録」からお試しください。", true);
      return;
    }

    // 検出した商品名をもとに、実際の在庫を検索する
    const matched = [];
    const seenIds = new Set();
    for (const d of detected) {
      const cleanName = (d.name || "").trim();
      if (!cleanName) continue;
      const { data: found } = await supabaseClient
        .from("items").select("id, name, unit, item_lots(id, quantity, expiry_date)").ilike("name", "%" + cleanName + "%").limit(3);
      withTotalQuantity(found).forEach(item => {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          matched.push(item);
        }
      });
    }

    if (matched.length === 0) {
      showAppNotice("");
      showMessage(addMessageBox, "在庫に一致する商品が見つかりませんでした。「手動で消費登録」からお試しください。", true);
      return;
    }

    showAppNotice("");
    showConsumeReview(matched);
  } catch (err) {
    showAppNotice("");
    showMessage(addMessageBox, "判定エラー: " + err.message, true);
  } finally {
    e.target.value = "";
  }
});

// ---------- 手動での消費登録(検索して選ぶ) ----------
//
// 検索対象は [商品名]>[標準商品名]>[サブカテゴリー]>[カテゴリー]>[検索キーワード] の
// 優先度で、それぞれ部分一致させる(ひらがな読みを持つ項目はひらがな入力でも一致する)。
// 一致した項目のうちもっとも優先度が高いものを基準に検索結果を並べ替える。
const FIELD_PRIORITY = { name: 5, canonical: 4, subCategory: 3, category: 2, keyword: 1 };

function computeMatchScore(item, term) {
  const t = term.toLowerCase();
  const master = item.product_master;
  let score = 0;

  if ((item.name || "").toLowerCase().includes(t)) score = Math.max(score, FIELD_PRIORITY.name);

  if (master) {
    if ((master.canonical_name || "").toLowerCase().includes(t) || (master.canonical_name_reading || "").includes(t)) {
      score = Math.max(score, FIELD_PRIORITY.canonical);
    }
    if ((master.sub_category || "").toLowerCase().includes(t) || (master.sub_category_reading || "").includes(t)) {
      score = Math.max(score, FIELD_PRIORITY.subCategory);
    }
  }

  const category = (master && master.category) || item.category;
  if (category && (category.toLowerCase().includes(t) || getCategoryReading(category).includes(t))) {
    score = Math.max(score, FIELD_PRIORITY.category);
  }

  if (master && master.search_keywords) {
    const keywords = master.search_keywords || [];
    const readings = master.search_keywords_reading || [];
    for (let i = 0; i < keywords.length; i++) {
      if ((keywords[i] || "").toLowerCase().includes(t) || (readings[i] || "").includes(t)) {
        score = Math.max(score, FIELD_PRIORITY.keyword);
        break;
      }
    }
  }

  return score;
}

// 商品マスタのicon(手動設定)→無ければカテゴリー既定の絵文字、の順で決める。
// 商品マスタが無い商品は items.category に食品/日用品(種別)が入っているため、
// そのままgetCategoryIconの第1引数(type)として渡せば適切な既定アイコンにフォールバックする
function resolveSearchItemIcon(item) {
  const master = item.product_master;
  if (master) return master.icon || getCategoryIcon(master.type, master.category);
  return getCategoryIcon(item.category, null);
}

// 検索結果カード: 在庫確認画面・AI消費レビューと同じitem-cardの見た目に統一する。
// ヘッダー(アイコン・商品名・在庫・賞味期限・開閉シェブロン)をタップすると、
// 同じカードの中でロット調整欄+確定ボタンが開閉する(見切れを防ぐため、閉じている間は
// ヘッダーだけのコンパクト表示)
function consumeSearchCardHtml(item) {
  const nearestLot = sortLotsByExpiry(item.item_lots)[0];
  const expiryText = nearestLot ? formatExpiryLabel(nearestLot.expiry_date).text : "在庫なし";
  const icon = resolveSearchItemIcon(item);

  const lots = sortLotsByExpiry(item.item_lots);
  const lotsHtml = lots.length
    ? lots.map(lot => consumeLotRowHtml(item, lot)).join("")
    : '<div class="empty-note">在庫がありません。</div>';

  return `
    <div class="item-card consume-search-card" data-id="${item.id}">
      <div class="consume-search-header" data-action="toggle-consume-item">
        <span class="consume-search-icon">${icon}</span>
        <div class="consume-search-info">
          <div class="item-name">${escapeHtml(item.name)}</div>
          <div class="shopping-meta">在庫: ${item.quantity}${escapeHtml(item.unit)} ・ ${escapeHtml(expiryText)}</div>
        </div>
        <span class="material-symbols-rounded consume-search-chevron">expand_more</span>
      </div>
      <div class="consume-search-detail hidden">
        <div class="lot-list">
          ${lotsHtml}
        </div>
        <button type="button" class="btn-primary consume-confirm-btn" data-action="confirm-inline-consume">
          <span class="material-symbols-rounded">done_all</span> 確定
        </button>
      </div>
    </div>
  `;
}

// 検索結果はロット明細も必要なため、data属性に平坦化せずそのまま保持してidで引く
let lastSearchResults = [];
let searchToken = 0;
let searchDebounceTimer = null;

async function runConsumeSearch(term) {
  const myToken = ++searchToken;

  if (!term) {
    consumeSearchResultsEl.innerHTML = "";
    lastSearchResults = [];
    return;
  }

  const { data, error } = await supabaseClient
    .from("items")
    .select("id, name, unit, category, item_lots(id, quantity, expiry_date), product_master(icon, type, canonical_name, canonical_name_reading, category, sub_category, sub_category_reading, search_keywords, search_keywords_reading)");

  if (myToken !== searchToken) return; // 入力中に古いレスポンスが返ってきた場合は捨てる

  if (error || !data) {
    consumeSearchResultsEl.innerHTML = '<div class="empty-note">検索中にエラーが発生しました</div>';
    lastSearchResults = [];
    return;
  }

  const scored = data
    .map(item => ({ item, score: computeMatchScore(item, term) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "ja"));

  if (scored.length === 0) {
    consumeSearchResultsEl.innerHTML = '<div class="empty-note">見つかりませんでした</div>';
    lastSearchResults = [];
    return;
  }

  lastSearchResults = withTotalQuantity(scored.map(s => s.item));
  consumeSearchResultsEl.innerHTML = lastSearchResults.map(item => consumeSearchCardHtml(item)).join("");
  if (window.lucide) lucide.createIcons();
}

// 入力のたびに検索するが、1文字ごとの問い合わせを避けるため軽くデバウンスする
consumeSearchInput.addEventListener("input", (e) => {
  const term = e.target.value.trim();
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => runConsumeSearch(term), 280);
});

// 検索結果カードのヘッダーを押すと、同じカードの中でロット調整欄+確定ボタンが開閉する。
// 他のカードを押すと今開いているカードは閉じ、同じカードを押した場合はトグルで閉じるだけにする
function expandConsumeSearchCard(card) {
  card.classList.add("expanded");
  card.querySelector(".consume-search-detail").classList.remove("hidden");
}
function collapseConsumeSearchCard(card) {
  card.classList.remove("expanded");
  card.querySelector(".consume-search-detail").classList.add("hidden");
}

async function confirmInlineConsume(cardEl) {
  const itemId = cardEl.dataset.id;
  const lotNums = cardEl.querySelectorAll('[data-action="edit-consume-lot-qty"]');
  let consumedAny = false;
  for (const numEl of lotNums) {
    const remainingQty = Number(numEl.dataset.qty) || 0;
    const originalQty = Number(numEl.dataset.originalQty) || 0;
    if (remainingQty >= originalQty) continue;
    await persistLotQty(numEl.dataset.lotId, itemId, remainingQty);
    consumedAny = true;
  }

  const message = consumedAny ? "消費しました" : "数量に変更がなかったため消費されませんでした";
  showMessage(consumeMessageBox, message, false);
  if (consumedAny) showAppNotice(message);

  loadItems();
  loadShoppingList();

  // 消費後は在庫表示・展開状態が古くなるため、同じ検索語で結果を作り直す
  const term = consumeSearchInput.value.trim();
  if (term) runConsumeSearch(term);
}

consumeSearchResultsEl.addEventListener("click", (e) => {
  const confirmBtn = e.target.closest('[data-action="confirm-inline-consume"]');
  if (confirmBtn) {
    confirmInlineConsume(confirmBtn.closest(".consume-search-card"));
    return;
  }

  const header = e.target.closest('[data-action="toggle-consume-item"]');
  if (!header) return;
  const card = header.closest(".consume-search-card");
  const alreadyExpanded = card.classList.contains("expanded");

  // 同時に開けるのは1件のみ。他に開いているカードがあれば閉じる
  consumeSearchResultsEl.querySelectorAll(".consume-search-card.expanded").forEach(openCard => {
    if (openCard !== card) collapseConsumeSearchCard(openCard);
  });

  if (alreadyExpanded) {
    collapseConsumeSearchCard(card); // 同じカードを押した場合はトグルで閉じるだけ
  } else {
    expandConsumeSearchCard(card);
  }
});

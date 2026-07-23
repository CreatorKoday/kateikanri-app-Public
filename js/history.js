// ==========================================================
// 購入・消費履歴ページ(ホーム画面の「購入履歴」カードから開く)
//
// item_lots は現在の在庫状態そのもの(消費で0になると行が削除される)なので、
// 増減のたびに js/items.js の logItemHistory() が item_history へ追記した記録を
// 新しい日付順の一覧(Excelの表のような見た目)で表示するだけの画面。
// 右上の鉛筆ボタンで編集モードに切り替えると、削除ボタンが現れ、各セルを
// 手入力で修正できるようになる(誤って記録された履歴を直すための機能)
// ==========================================================

import { supabaseClient } from "./config.js";
import { escapeHtml } from "./utils.js";
import { switchView } from "./navigation.js";
import { isContinuousUnit } from "./quantity.js";

// 件数が増え続けても一覧が重くならないよう、まずは直近分だけ表示する(絞り込み・
// もっと見る等は今回のスコープ外)
const HISTORY_LIMIT = 300;

// 直近に取得した一覧(編集モードの切替時に再取得せずそのまま再描画するために保持する)
let lastHistoryData = [];
let editMode = false;

function formatHistoryDate(occurredAt) {
  const dt = new Date(occurredAt);
  return `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}`;
}

// <input type="date">用のYYYY-MM-DD形式
function formatDateInputValue(occurredAt) {
  const dt = new Date(occurredAt);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function historyViewRowHtml(row) {
  const isPurchase = row.event_type === "purchase";
  const badgeClass = isPurchase ? "purchase" : "consumption";
  const badgeText = isPurchase ? "購入" : "消費";
  const priceText = row.price !== null && row.price !== undefined ? `${row.price}円` : "—";

  return `
    <tr>
      <td>${formatHistoryDate(row.occurred_at)}</td>
      <td>${escapeHtml(row.item_type || "—")}</td>
      <td>${escapeHtml(row.canonical_name || "—")}</td>
      <td>${escapeHtml(row.item_name)}</td>
      <td><span class="history-event-badge ${badgeClass}">${badgeText}</span></td>
      <td>${row.quantity}${escapeHtml(row.unit)}</td>
      <td>${priceText}</td>
      <td></td>
    </tr>
  `;
}

function historyEditRowHtml(row) {
  const isPurchase = row.event_type === "purchase";
  const isFood = row.item_type === "食品";
  const priceValue = row.price !== null && row.price !== undefined ? row.price : "";

  return `
    <tr data-history-row="${row.id}">
      <td><input type="date" class="history-edit-input" data-field="occurred_at" value="${formatDateInputValue(row.occurred_at)}"></td>
      <td>
        <select class="history-edit-input" data-field="item_type">
          <option value="食品" ${isFood ? "selected" : ""}>食品</option>
          <option value="日用品" ${!isFood ? "selected" : ""}>日用品</option>
        </select>
      </td>
      <td><input type="text" class="history-edit-input" data-field="canonical_name" value="${escapeHtml(row.canonical_name || "")}"></td>
      <td><input type="text" class="history-edit-input" data-field="item_name" value="${escapeHtml(row.item_name)}"></td>
      <td>
        <select class="history-edit-input" data-field="event_type">
          <option value="purchase" ${isPurchase ? "selected" : ""}>購入</option>
          <option value="consumption" ${!isPurchase ? "selected" : ""}>消費</option>
        </select>
      </td>
      <td><input type="number" class="history-edit-input history-edit-qty" data-field="quantity" value="${row.quantity}">${escapeHtml(row.unit)}</td>
      <td><input type="number" class="history-edit-input" data-field="price" value="${priceValue}"></td>
      <td>
        <button type="button" class="del-btn" data-action="delete-history-row" data-id="${row.id}" aria-label="この記録を削除">
          <span class="material-symbols-rounded">delete</span>
        </button>
      </td>
    </tr>
  `;
}

// サマリーページのカレンダーで特定の日付をタップした場合など、開始日・終了日が
// 同じ1日だけに絞り込まれている状態かどうか。この場合だけ、常に同じ値になり
// 冗長な日付列を隠す(並び順は下の並び替え機能で別途指定する、常時共通の仕組み)
function isSingleDayHistoryView() {
  return !!appliedHistoryFilters.dateFrom && appliedHistoryFilters.dateFrom === appliedHistoryFilters.dateTo;
}

// ---------- 並び替え(商品登録の「1つ当たり/合計金額」と同じデザインのスイッチを3段) ----------
// 日付(新しい順/古い順)は常に効き、同じ日付の中を区分(指定なし/消費が上/購入が上)→
// 金額(指定なし/高い順/安い順)の順で並べ替える。どちらも指定なしなら取得時点の順序
// (occurred_at降順)のまま保つ(Array.sortの安定ソートに委ねる)

const HISTORY_SORT_DEFAULT = { date: "desc", eventType: "none", amount: "none" };
export const appliedHistorySort = { ...HISTORY_SORT_DEFAULT };
let stagedHistorySort = { ...HISTORY_SORT_DEFAULT };

// item_history.priceは「1つ当たりの単価」だが、定量系(g/ml/kg/L)の商品は
// 「100◯当たりの単価」(手動登録の価格モード切替と同じ基準)で保存されているため、
// 金額(合計)を求める際は定量系だけ数量を100で割ってから単価を掛ける必要がある。
// summary.jsの月間集計もこの関数を共通で使う(個別に計算式を持たない)
export function computeHistoryRowAmount(row) {
  if (row.price === null || row.price === undefined) return 0;
  const quantity = Number(row.quantity);
  const price = Number(row.price);
  return isContinuousUnit(row.unit) ? (quantity / 100) * price : quantity * price;
}

function compareHistoryRows(a, b) {
  const dateKeyA = formatDateInputValue(a.occurred_at);
  const dateKeyB = formatDateInputValue(b.occurred_at);
  if (dateKeyA !== dateKeyB) {
    const cmp = dateKeyA < dateKeyB ? -1 : 1;
    return appliedHistorySort.date === "asc" ? cmp : -cmp;
  }

  if (appliedHistorySort.eventType !== "none") {
    const rank = (r) => {
      const isConsumption = r.event_type === "consumption";
      const consumptionFirst = appliedHistorySort.eventType === "consumption-first";
      return isConsumption === consumptionFirst ? 0 : 1;
    };
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
  }

  if (appliedHistorySort.amount !== "none") {
    const diff = computeHistoryRowAmount(b) - computeHistoryRowAmount(a); // 高い順が基準
    return appliedHistorySort.amount === "asc" ? -diff : diff;
  }

  return 0;
}

function renderHistorySortToggles() {
  document.querySelectorAll(".history-sort-toggle").forEach(toggle => {
    const field = toggle.dataset.field;
    toggle.querySelectorAll(".price-mode-option").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.value === stagedHistorySort[field]);
    });
  });
}

document.getElementById("history-sort-btn").addEventListener("click", () => {
  stagedHistorySort = { ...appliedHistorySort };
  renderHistorySortToggles();
  document.getElementById("history-sort-overlay").classList.remove("hidden");
});

function closeHistorySortOverlay() {
  document.getElementById("history-sort-overlay").classList.add("hidden");
}
document.getElementById("history-sort-close-btn").addEventListener("click", closeHistorySortOverlay);

document.querySelectorAll(".history-sort-toggle").forEach(toggle => {
  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".price-mode-option");
    if (!btn) return;
    stagedHistorySort[toggle.dataset.field] = btn.dataset.value;
    renderHistorySortToggles();
  });
});

document.getElementById("history-sort-clear-btn").addEventListener("click", () => {
  stagedHistorySort = { ...HISTORY_SORT_DEFAULT };
  renderHistorySortToggles();
});

document.getElementById("history-sort-apply-btn").addEventListener("click", () => {
  appliedHistorySort.date = stagedHistorySort.date;
  appliedHistorySort.eventType = stagedHistorySort.eventType;
  appliedHistorySort.amount = stagedHistorySort.amount;
  closeHistorySortOverlay();
  renderHistoryTable();
});

function renderHistoryTable() {
  const tbody = document.getElementById("history-table-body");
  const table = document.querySelector(".history-table");
  table.classList.toggle("day-view", isSingleDayHistoryView());

  if (lastHistoryData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8">まだ購入・消費の記録がありません。</td></tr>';
    return;
  }

  const filtered = lastHistoryData.filter(matchesHistoryFilters).sort(compareHistoryRows);
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8">条件に一致する記録がありません。</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(editMode ? historyEditRowHtml : historyViewRowHtml).join("");
}

// サマリーページのカレンダーで日付をタップした時の入口。他の絞り込み条件(種別など)は
// 維持したまま、日付の範囲だけをその1日に絞り込んで購入履歴ページへ遷移する
export function openHistoryForDate(dateKey) {
  appliedHistoryFilters.dateFrom = dateKey;
  appliedHistoryFilters.dateTo = dateKey;
  updateHistoryFilterButtonLabel();
  switchView("history");
  loadItemHistory();
}

export async function loadItemHistory() {
  const tbody = document.getElementById("history-table-body");
  const { data, error } = await supabaseClient
    .from("item_history")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="8">読み込みエラー: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  lastHistoryData = data || [];
  updateHistoryFilterButtonLabel();
  renderHistoryTable();
}

// ---------- 絞り込みフィルター(在庫確認画面と同じAmazon風2ペイン) ----------
// 日付・価格はチェックボックスではなく範囲(from/to)入力にする点だけ在庫確認画面と異なる

const historyFilterDefs = [
  { key: "date", label: "日付", kind: "range-date" },
  { key: "type", label: "種別", kind: "checkbox" },
  { key: "canonicalName", label: "標準商品名", kind: "checkbox" },
  { key: "eventType", label: "区分", kind: "checkbox" },
  { key: "price", label: "価格", kind: "range-number" }
];

// 実際の絞り込みに使われている確定済みの条件。summary.jsからも参照するため、
// オブジェクトを差し替えるのではなく、常に同じインスタンスのプロパティを書き換える
export const appliedHistoryFilters = {
  dateFrom: "", dateTo: "",
  type: new Set(), canonicalName: new Set(), eventType: new Set(),
  priceMin: "", priceMax: ""
};

// フィルター画面を開いている間だけの一時的な選択(チェックボックスの3種類)
let stagedHistoryFilterSets = { type: new Set(), canonicalName: new Set(), eventType: new Set() };
// 日付・価格は範囲入力のため、タブを切り替えても値が消えないようここに保持する
let stagedDateFrom = "";
let stagedDateTo = "";
let stagedPriceMin = "";
let stagedPriceMax = "";
let activeHistoryFilterKey = historyFilterDefs[0].key;

function eventTypeLabel(value) {
  return value === "purchase" ? "購入" : "消費";
}

function computeHistoryTypeOptions() {
  return Array.from(new Set(lastHistoryData.map(r => r.item_type).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
}
function computeHistoryCanonicalNameOptions() {
  return Array.from(new Set(lastHistoryData.map(r => r.canonical_name).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja"));
}
function computeHistoryEventTypeOptions() {
  return Array.from(new Set(lastHistoryData.map(r => r.event_type).filter(Boolean)));
}

function optionsForHistoryFilterKey(key) {
  if (key === "type") return computeHistoryTypeOptions();
  if (key === "canonicalName") return computeHistoryCanonicalNameOptions();
  if (key === "eventType") return computeHistoryEventTypeOptions();
  return [];
}

// 範囲入力(日付・価格)タブから離れる直前に、現在の入力値をステージ変数へ保存する
// (options paneはタブ切替のたびに丸ごと差し替わるため、DOM任せだと値が消えてしまう)
function saveActiveRangeInputs() {
  if (activeHistoryFilterKey === "date") {
    const fromEl = document.getElementById("history-filter-date-from");
    const toEl = document.getElementById("history-filter-date-to");
    if (fromEl) stagedDateFrom = fromEl.value;
    if (toEl) stagedDateTo = toEl.value;
  } else if (activeHistoryFilterKey === "price") {
    const minEl = document.getElementById("history-filter-price-min");
    const maxEl = document.getElementById("history-filter-price-max");
    if (minEl) stagedPriceMin = minEl.value;
    if (maxEl) stagedPriceMax = maxEl.value;
  }
}

function renderHistoryFilterTypes() {
  const el = document.getElementById("history-filter-types");
  el.innerHTML = historyFilterDefs.map(def => `
    <div class="filter-type-row ${def.key === activeHistoryFilterKey ? "active" : ""}" data-key="${def.key}">${def.label}</div>
  `).join("");
}

function renderHistoryFilterOptions() {
  const el = document.getElementById("history-filter-options");
  const def = historyFilterDefs.find(d => d.key === activeHistoryFilterKey);

  if (def.kind === "range-date") {
    el.innerHTML = `
      <div class="history-filter-range-row">
        <label>開始日</label>
        <input type="text" class="date-display" id="history-filter-date-from" placeholder="指定なし" readonly value="${escapeHtml(stagedDateFrom)}">
      </div>
      <div class="history-filter-range-row">
        <label>終了日</label>
        <input type="text" class="date-display" id="history-filter-date-to" placeholder="指定なし" readonly value="${escapeHtml(stagedDateTo)}">
      </div>
    `;
    return;
  }

  if (def.kind === "range-number") {
    el.innerHTML = `
      <div class="history-filter-range-row">
        <label>最小(円)</label>
        <input type="number" id="history-filter-price-min" placeholder="指定なし" value="${escapeHtml(stagedPriceMin)}">
      </div>
      <div class="history-filter-range-row">
        <label>最大(円)</label>
        <input type="number" id="history-filter-price-max" placeholder="指定なし" value="${escapeHtml(stagedPriceMax)}">
      </div>
    `;
    return;
  }

  const options = optionsForHistoryFilterKey(activeHistoryFilterKey);
  const set = stagedHistoryFilterSets[activeHistoryFilterKey];
  el.innerHTML = options.length
    ? options.map(value => `
        <div class="filter-option-row" data-value="${escapeHtml(value)}">
          <span class="filter-option-checkbox ${set.has(value) ? "checked" : ""}"></span>
          <span>${escapeHtml(activeHistoryFilterKey === "eventType" ? eventTypeLabel(value) : value)}</span>
        </div>
      `).join("")
    : '<div class="empty-note">選択肢がありません。</div>';
}

function renderHistoryFilterSummary() {
  const el = document.getElementById("history-filter-summary");
  const parts = [];
  if (stagedDateFrom || stagedDateTo) parts.push(`[${stagedDateFrom || "…"}〜${stagedDateTo || "…"}]`);
  if (stagedHistoryFilterSets.type.size > 0) parts.push(`[${Array.from(stagedHistoryFilterSets.type).join("・")}]`);
  if (stagedHistoryFilterSets.canonicalName.size > 0) parts.push(`[${Array.from(stagedHistoryFilterSets.canonicalName).join("・")}]`);
  if (stagedHistoryFilterSets.eventType.size > 0) parts.push(`[${Array.from(stagedHistoryFilterSets.eventType).map(eventTypeLabel).join("・")}]`);
  if (stagedPriceMin || stagedPriceMax) parts.push(`[${stagedPriceMin || "0"}円〜${stagedPriceMax || "∞"}円]`);

  const text = parts.join(" > ");
  el.textContent = text;
  el.classList.toggle("hidden", !text);
}

function updateHistoryFilterButtonLabel() {
  const count =
    (appliedHistoryFilters.dateFrom || appliedHistoryFilters.dateTo ? 1 : 0) +
    appliedHistoryFilters.type.size +
    appliedHistoryFilters.canonicalName.size +
    appliedHistoryFilters.eventType.size +
    (appliedHistoryFilters.priceMin || appliedHistoryFilters.priceMax ? 1 : 0);

  const label = document.querySelector("#history-filter-btn .inventory-filter-btn-label");
  label.textContent = count > 0 ? `フィルター (${count})` : "フィルター";
}

function openHistoryFilterOverlay() {
  stagedHistoryFilterSets = {
    type: new Set(appliedHistoryFilters.type),
    canonicalName: new Set(appliedHistoryFilters.canonicalName),
    eventType: new Set(appliedHistoryFilters.eventType)
  };
  stagedDateFrom = appliedHistoryFilters.dateFrom;
  stagedDateTo = appliedHistoryFilters.dateTo;
  stagedPriceMin = appliedHistoryFilters.priceMin;
  stagedPriceMax = appliedHistoryFilters.priceMax;
  activeHistoryFilterKey = historyFilterDefs[0].key;

  renderHistoryFilterTypes();
  renderHistoryFilterOptions();
  renderHistoryFilterSummary();
  document.getElementById("history-filter-overlay").classList.remove("hidden");
}

function closeHistoryFilterOverlay() {
  document.getElementById("history-filter-overlay").classList.add("hidden");
}

document.getElementById("history-filter-btn").addEventListener("click", openHistoryFilterOverlay);
document.getElementById("history-filter-close-btn").addEventListener("click", closeHistoryFilterOverlay);
document.getElementById("history-filter-overlay").addEventListener("click", (e) => {
  if (e.target.id === "history-filter-overlay") closeHistoryFilterOverlay();
});

document.getElementById("history-filter-types").addEventListener("click", (e) => {
  const row = e.target.closest(".filter-type-row");
  if (!row) return;
  saveActiveRangeInputs();
  activeHistoryFilterKey = row.dataset.key;
  renderHistoryFilterTypes();
  renderHistoryFilterOptions();
});

document.getElementById("history-filter-options").addEventListener("click", (e) => {
  const row = e.target.closest(".filter-option-row");
  if (!row) return;
  const set = stagedHistoryFilterSets[activeHistoryFilterKey];
  const value = row.dataset.value;
  if (set.has(value)) set.delete(value); else set.add(value);
  renderHistoryFilterOptions();
  renderHistoryFilterSummary();
});

// 日付(カレンダー選択→change発火)・価格(手入力)の範囲入力は、案内文をその場で
// 更新できるよう、値が変わるたびにステージ変数へ反映する
document.getElementById("history-filter-options").addEventListener("input", (e) => {
  if (!e.target.matches("#history-filter-price-min, #history-filter-price-max")) return;
  saveActiveRangeInputs();
  renderHistoryFilterSummary();
});
document.getElementById("history-filter-options").addEventListener("change", (e) => {
  if (!e.target.matches("#history-filter-date-from, #history-filter-date-to")) return;
  saveActiveRangeInputs();
  renderHistoryFilterSummary();
});

document.getElementById("history-filter-clear-btn").addEventListener("click", () => {
  stagedHistoryFilterSets = { type: new Set(), canonicalName: new Set(), eventType: new Set() };
  stagedDateFrom = ""; stagedDateTo = ""; stagedPriceMin = ""; stagedPriceMax = "";
  renderHistoryFilterOptions();
  renderHistoryFilterSummary();
});

document.getElementById("history-filter-apply-btn").addEventListener("click", () => {
  saveActiveRangeInputs();
  appliedHistoryFilters.dateFrom = stagedDateFrom;
  appliedHistoryFilters.dateTo = stagedDateTo;
  appliedHistoryFilters.type = new Set(stagedHistoryFilterSets.type);
  appliedHistoryFilters.canonicalName = new Set(stagedHistoryFilterSets.canonicalName);
  appliedHistoryFilters.eventType = new Set(stagedHistoryFilterSets.eventType);
  appliedHistoryFilters.priceMin = stagedPriceMin;
  appliedHistoryFilters.priceMax = stagedPriceMax;

  updateHistoryFilterButtonLabel();
  closeHistoryFilterOverlay();
  renderHistoryTable();
});

// summary.jsからも共通で使う判定関数。行がappliedHistoryFiltersの条件をすべて満たすか判定する
export function matchesHistoryFilters(row) {
  const dateKey = formatDateInputValue(row.occurred_at);
  if (appliedHistoryFilters.dateFrom && dateKey < appliedHistoryFilters.dateFrom) return false;
  if (appliedHistoryFilters.dateTo && dateKey > appliedHistoryFilters.dateTo) return false;
  if (appliedHistoryFilters.type.size > 0 && !appliedHistoryFilters.type.has(row.item_type)) return false;
  if (appliedHistoryFilters.canonicalName.size > 0 && !appliedHistoryFilters.canonicalName.has(row.canonical_name)) return false;
  if (appliedHistoryFilters.eventType.size > 0 && !appliedHistoryFilters.eventType.has(row.event_type)) return false;
  if (appliedHistoryFilters.priceMin !== "" && (row.price === null || row.price === undefined || Number(row.price) < Number(appliedHistoryFilters.priceMin))) return false;
  if (appliedHistoryFilters.priceMax !== "" && (row.price === null || row.price === undefined || Number(row.price) > Number(appliedHistoryFilters.priceMax))) return false;
  return true;
}

// 手入力した1項目をitem_historyへ反映する
async function commitFieldEdit(rowId, field, rawValue) {
  let value = rawValue;

  if (field === "occurred_at") {
    if (!rawValue) return;
    value = new Date(rawValue + "T00:00:00").toISOString();
  } else if (field === "quantity" || field === "price") {
    value = rawValue === "" ? null : Number(rawValue);
    if (field === "quantity" && (value === null || Number.isNaN(value))) return; // 数量は空にできない
  } else if (field === "canonical_name") {
    value = rawValue.trim() || null;
  } else if (field === "item_name") {
    value = rawValue.trim();
    if (!value) return; // 商品名は空にできない
  }

  const { error } = await supabaseClient.from("item_history").update({ [field]: value }).eq("id", rowId);
  if (error) { console.error("履歴の編集に失敗:", error); return; }

  // 編集モードのon/off切替は再取得せずlastHistoryDataを再描画するだけなので、
  // メモリ上のキャッシュにも今回の変更を反映しておく
  const cached = lastHistoryData.find(row => row.id === rowId);
  if (cached) cached[field] = value;
}

// カード内のボタン・入力欄はloadItemHistory()/編集モード切替のたびに再生成されるため、
// tbodyへの委譲で拾う
const historyTableBodyEl = document.getElementById("history-table-body");

historyTableBodyEl.addEventListener("click", async (e) => {
  const deleteBtn = e.target.closest('[data-action="delete-history-row"]');
  if (!deleteBtn) return;

  if (!confirm("この記録を削除しますか?")) return;

  const { error } = await supabaseClient.from("item_history").delete().eq("id", deleteBtn.dataset.id);
  if (error) {
    console.error("履歴の削除に失敗:", error);
    return;
  }
  loadItemHistory();
});

historyTableBodyEl.addEventListener("change", (e) => {
  const input = e.target.closest(".history-edit-input");
  if (!input) return;
  const row = input.closest("tr[data-history-row]");
  if (!row) return;
  commitFieldEdit(row.dataset.historyRow, input.dataset.field, input.value);
});

document.getElementById("history-edit-toggle-btn").addEventListener("click", () => {
  editMode = !editMode;
  document.getElementById("history-edit-toggle-btn").classList.toggle("active", editMode);
  renderHistoryTable();
});

document.getElementById("history-open-btn").addEventListener("click", () => {
  switchView("history");
  editMode = false;
  document.getElementById("history-edit-toggle-btn").classList.remove("active");
  loadItemHistory();
});
// ホームに戻る際は、フィルター・並び替えを次回開いた時のために初期状態へ戻す
// (オーバーレイを開いた時点でstaged側はappliedからコピーし直すため、ここではappliedだけ戻せばよい)
function resetHistoryFiltersAndSort() {
  appliedHistoryFilters.dateFrom = "";
  appliedHistoryFilters.dateTo = "";
  appliedHistoryFilters.type = new Set();
  appliedHistoryFilters.canonicalName = new Set();
  appliedHistoryFilters.eventType = new Set();
  appliedHistoryFilters.priceMin = "";
  appliedHistoryFilters.priceMax = "";
  updateHistoryFilterButtonLabel();

  appliedHistorySort.date = HISTORY_SORT_DEFAULT.date;
  appliedHistorySort.eventType = HISTORY_SORT_DEFAULT.eventType;
  appliedHistorySort.amount = HISTORY_SORT_DEFAULT.amount;
}

document.getElementById("history-back-btn").addEventListener("click", () => {
  resetHistoryFiltersAndSort();
  switchView("home");
});

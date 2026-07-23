// ==========================================================
// 購入・消費サマリー(月間カレンダー)ページ
//
// 購入履歴ページの「サマリー」ボタンから開く。item_history(quantity×price)を
// 日付ごとに集計し、その日に購入した金額・消費した金額をカレンダーの日付マスに
// 表示するだけの読み取り専用ページ。日付選択用の自作カレンダー(js/calendar.js)とは
// 目的(値の選択 ではなく 集計の表示)が異なるため、別モジュールとして実装している
// ==========================================================

import { supabaseClient } from "./config.js";
import { switchView } from "./navigation.js";
import { matchesHistoryFilters, openHistoryForDate, computeHistoryRowAmount } from "./history.js";

let summaryViewDate = new Date();

function localDateKey(dateLike) {
  const d = new Date(dateLike);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function renderSummaryCalendar(year, month, totalsByDay) {
  const grid = document.getElementById("summary-calendar-grid");
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = localDateKey(new Date());

  const dows = ["日", "月", "火", "水", "木", "金", "土"];
  let html = dows.map(d => `<div class="summary-cal-dow">${d}</div>`).join("");

  for (let i = 0; i < startWeekday; i++) html += `<div class="summary-cal-day empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const key = localDateKey(new Date(year, month, d));
    const totals = totalsByDay[key] || { purchase: 0, consumption: 0 };
    const isToday = key === todayKey;

    html += `
      <div class="summary-cal-day ${isToday ? "today" : ""}" data-date="${key}">
        <span class="summary-cal-day-num">${d}</span>
        ${totals.purchase > 0 ? `
          <span class="summary-cal-line purchase">
            <span class="material-symbols-rounded">shopping_cart</span>${Math.round(totals.purchase)}
          </span>` : ""}
        ${totals.consumption > 0 ? `
          <span class="summary-cal-line consumption">
            <span class="material-symbols-rounded">remove</span>${Math.round(totals.consumption)}
          </span>` : ""}
      </div>
    `;
  }

  grid.innerHTML = html;
}

async function loadSummaryMonth() {
  const year = summaryViewDate.getFullYear();
  const month = summaryViewDate.getMonth();
  document.getElementById("summary-cal-month-label").textContent = `${year}年${month + 1}月`;

  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 1);

  const { data, error } = await supabaseClient
    .from("item_history")
    .select("occurred_at, event_type, quantity, price, unit, item_type, canonical_name")
    .gte("occurred_at", monthStart.toISOString())
    .lt("occurred_at", monthEnd.toISOString());

  const totalsByDay = {};
  if (!error && data) {
    // 購入履歴ページの絞り込みフィルターと同じ条件をサマリーにも反映する
    data.filter(matchesHistoryFilters).forEach(row => {
      // 価格が無い記録(AI写真判定経由など)は金額を計算できないため集計から除く
      if (row.price === null || row.price === undefined) return;
      const key = localDateKey(row.occurred_at);
      // 定量系(g/ml等)はitem_history.priceが「100◯当たりの単価」のため、
      // js/history.jsのcomputeHistoryRowAmountで正しく換算する(数量×単価では誤る)
      const amount = computeHistoryRowAmount(row);
      if (!totalsByDay[key]) totalsByDay[key] = { purchase: 0, consumption: 0 };
      totalsByDay[key][row.event_type] = (totalsByDay[key][row.event_type] || 0) + amount;
    });
  }

  if (error) console.error("サマリーの取得に失敗:", error);
  renderSummaryCalendar(year, month, totalsByDay);
}

// 年月のプルダウン選択。消費期限入力のカレンダー(#calendar-overlay)と同じく、
// 画面の上の層に背景をぼかして表示するオーバーレイにする(サマリーは常にどこかの
// 月を表示するため「未設定にする」ボタンは無い)
const summaryYearSelect = document.getElementById("summary-cal-year-select");
const summaryMonthSelect = document.getElementById("summary-cal-month-select");
for (let m = 1; m <= 12; m++) {
  const opt = document.createElement("option");
  opt.value = m;
  opt.textContent = m + "月";
  summaryMonthSelect.appendChild(opt);
}

function closeSummaryYearMonthOverlay() {
  document.getElementById("summary-yearmonth-overlay").classList.add("hidden");
}

document.getElementById("summary-cal-month-label").addEventListener("click", () => {
  const currentYear = new Date().getFullYear();
  const viewYear = summaryViewDate.getFullYear();
  summaryYearSelect.innerHTML = "";
  for (let y = currentYear; y <= currentYear + 10; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y + "年";
    if (y === viewYear) opt.selected = true;
    summaryYearSelect.appendChild(opt);
  }
  summaryMonthSelect.value = summaryViewDate.getMonth() + 1;

  document.getElementById("summary-yearmonth-overlay").classList.remove("hidden");
});

document.getElementById("summary-yearmonth-overlay").addEventListener("click", (e) => {
  if (e.target.id === "summary-yearmonth-overlay") closeSummaryYearMonthOverlay();
});
document.getElementById("summary-yearmonth-close-btn").addEventListener("click", closeSummaryYearMonthOverlay);

function applySummaryYearMonthSelection() {
  summaryViewDate = new Date(Number(summaryYearSelect.value), Number(summaryMonthSelect.value) - 1, 1);
  closeSummaryYearMonthOverlay();
  loadSummaryMonth();
}
summaryYearSelect.addEventListener("change", applySummaryYearMonthSelection);
summaryMonthSelect.addEventListener("change", applySummaryYearMonthSelection);

document.getElementById("summary-cal-prev").addEventListener("click", () => {
  summaryViewDate = new Date(summaryViewDate.getFullYear(), summaryViewDate.getMonth() - 1, 1);
  loadSummaryMonth();
});
document.getElementById("summary-cal-next").addEventListener("click", () => {
  summaryViewDate = new Date(summaryViewDate.getFullYear(), summaryViewDate.getMonth() + 1, 1);
  loadSummaryMonth();
});

// カレンダーのマスはloadSummaryMonth()のたびに再生成されるため、グリッドへの委譲で拾う
document.getElementById("summary-calendar-grid").addEventListener("click", (e) => {
  const day = e.target.closest(".summary-cal-day:not(.empty)");
  if (!day) return;
  openHistoryForDate(day.dataset.date);
});

document.getElementById("summary-open-btn").addEventListener("click", () => {
  switchView("summary");
  summaryViewDate = new Date();
  closeSummaryYearMonthOverlay();
  loadSummaryMonth();
});
document.getElementById("summary-back-btn").addEventListener("click", () => switchView("history"));

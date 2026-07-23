// ==========================================================
// 在庫収支表(貸借対照表風)ページ
//
// 購入履歴ページの「収支表」ボタンから開く。item_history を月単位で集計し、
// 食品/日用品ごとに「前月繰越・今月購入・今月消費(貸方)」と、そこから自動計算
// した「今月末在庫(借方)」を左右2カラムで表示する。
//
// 前月繰越 = 表示中の月の開始日より前の全履歴を「購入は+・消費は-」として
// 累積した金額(=その月の期首在庫評価額)。今月末在庫 = 前月繰越+今月購入-今月消費
// となるため、借方合計(今月末在庫の合計)と貸方合計(前月繰越+今月購入-今月消費の合計)は
// 計算上必ず一致する。
// ==========================================================

import { supabaseClient } from "./config.js";
import { switchView } from "./navigation.js";
import { computeHistoryRowAmount } from "./history.js";

let balanceViewDate = new Date();

function categoryOf(row) {
  return row.item_type === "日用品" ? "daily" : "food";
}

// 表示中の月より前の全履歴を、購入は+・消費は-として食品/日用品ごとに累積する
function computeCarryForward(rows) {
  const totals = { food: 0, daily: 0 };
  rows.forEach(row => {
    const amount = computeHistoryRowAmount(row);
    totals[categoryOf(row)] += row.event_type === "purchase" ? amount : -amount;
  });
  return totals;
}

// 表示中の月の履歴を、区分(購入/消費)×食品/日用品ごとに合計する
function computeMonthTotals(rows, eventType) {
  const totals = { food: 0, daily: 0 };
  rows.filter(row => row.event_type === eventType).forEach(row => {
    totals[categoryOf(row)] += computeHistoryRowAmount(row);
  });
  return totals;
}

// 会計風のマイナス表記(▲9,000)。整数に丸めて3桁区切りにする
function formatAccountingYen(amount) {
  const rounded = Math.round(amount);
  const text = Math.abs(rounded).toLocaleString("ja-JP");
  return rounded < 0 ? `▲${text}円` : `${text}円`;
}

function renderBalanceTable(carry, purchase, consumption) {
  const endStock = {
    food: carry.food + purchase.food - consumption.food,
    daily: carry.daily + purchase.daily - consumption.daily
  };
  const total = endStock.food + endStock.daily;

  const rows = [
    ["食品 今月末在庫", formatAccountingYen(endStock.food), "食品 前月繰越", formatAccountingYen(carry.food)],
    ["日用品 今月末在庫", formatAccountingYen(endStock.daily), "食品 今月購入", formatAccountingYen(purchase.food)],
    ["", "", "食品 今月消費", formatAccountingYen(-consumption.food)],
    ["", "", "日用品 前月繰越", formatAccountingYen(carry.daily)],
    ["", "", "日用品 今月購入", formatAccountingYen(purchase.daily)],
    ["", "", "日用品 今月消費", formatAccountingYen(-consumption.daily)]
  ];

  document.getElementById("balance-table-body").innerHTML = rows.map(([l1, v1, l2, v2]) => `
    <tr>
      <td>${l1}</td>
      <td>${v1}</td>
      <td>${l2}</td>
      <td>${v2}</td>
    </tr>
  `).join("");

  document.getElementById("balance-total-left").textContent = formatAccountingYen(total);
  document.getElementById("balance-total-right").textContent = formatAccountingYen(total);
}

async function loadBalanceSheet() {
  const year = balanceViewDate.getFullYear();
  const month = balanceViewDate.getMonth();
  document.getElementById("balance-cal-month-label").textContent = `${year}年${month + 1}月`;

  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 1);

  const [{ data: prevRows, error: prevError }, { data: monthRows, error: monthError }] = await Promise.all([
    supabaseClient.from("item_history").select("event_type, quantity, price, unit, item_type").lt("occurred_at", monthStart.toISOString()),
    supabaseClient.from("item_history").select("event_type, quantity, price, unit, item_type").gte("occurred_at", monthStart.toISOString()).lt("occurred_at", monthEnd.toISOString())
  ]);

  if (prevError || monthError) {
    console.error("収支表の取得に失敗:", prevError || monthError);
    return;
  }

  const carry = computeCarryForward(prevRows || []);
  const purchase = computeMonthTotals(monthRows || [], "purchase");
  const consumption = computeMonthTotals(monthRows || [], "consumption");
  renderBalanceTable(carry, purchase, consumption);
}

document.getElementById("balance-cal-prev").addEventListener("click", () => {
  balanceViewDate = new Date(balanceViewDate.getFullYear(), balanceViewDate.getMonth() - 1, 1);
  loadBalanceSheet();
});
document.getElementById("balance-cal-next").addEventListener("click", () => {
  balanceViewDate = new Date(balanceViewDate.getFullYear(), balanceViewDate.getMonth() + 1, 1);
  loadBalanceSheet();
});

document.getElementById("balance-open-btn").addEventListener("click", () => {
  switchView("balance");
  balanceViewDate = new Date();
  loadBalanceSheet();
});
document.getElementById("balance-back-btn").addEventListener("click", () => switchView("history"));

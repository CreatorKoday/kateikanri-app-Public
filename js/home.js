// ==========================================================
// ホーム画面: 「商品を登録」「商品を消費」の各アコーディオン内で、AI/手動の2ボタンを扱う。
//
// ・登録のAI/消費のAI: ボタンやウィンドウを表示せず、直接カメラ/写真選択を起動する。
// ・登録の手動/消費の手動: どちらも各機能側の共通オーバーレイを開く
//   (このファイルでは開くきっかけを渡すだけで、中身の表示・入力・確定はitems.js/aiPhoto.js/consume.jsが持つ)。
//
// 【重要】このファイルは見た目・表示切り替えの制御のみを行う。
// photo-btn / add-item-btn / consume-photo-btn などは、aiPhoto.js / items.js / consume.js に
// 元々あるイベントリスナーがそのまま動作する(ここでは追加のリスナーを乗せて表示切り替えを制御するだけ)。
// ==========================================================

import { openRegisterManualOverlay, closeRegisterOverlay } from "./items.js";
import { openConsumeSearchOverlay } from "./consume.js";

// ---------- 商品を登録 ----------

function openRegisterAi() {
  document.getElementById("photo-btn").click();
}

// ---------- 商品を消費 ----------

function openConsumeAi() {
  document.getElementById("consume-photo-btn").click();
}

document.querySelectorAll(".action-menu-card").forEach(card => {
  card.addEventListener("click", () => {
    const target = card.dataset.target;
    if (target === "ai") openRegisterAi();
    else if (target === "manual") openRegisterManualOverlay();
    else if (target === "consume-ai") openConsumeAi();
    else if (target === "consume-manual") openConsumeSearchOverlay();
  });
});

// ---------- 完了したら自動でオーバーレイを閉じる ----------

function watchSuccessMessage(elId, onSuccess) {
  const el = document.getElementById(elId);
  new MutationObserver(() => {
    if (el.classList.contains("msg-ok") && el.textContent) {
      setTimeout(onSuccess, 700);
    }
  }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
}

watchSuccessMessage("manual-add-message", closeRegisterOverlay); // 手動登録の成功

// ---------- 挨拶・日付の表示 ----------

function renderHomeGreeting() {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5 ? "こんばんは" : hour < 11 ? "おはようございます" : hour < 18 ? "こんにちは" : "こんばんは";
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][now.getDay()];
  document.getElementById("home-greeting").textContent = greeting;
  document.getElementById("home-date").textContent =
    `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日(${weekday})`;
}
renderHomeGreeting();

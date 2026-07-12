// ==========================================================
// ホーム画面のダッシュボード化
//
// 「食材を登録」「食材を消費」ともに、ページ遷移・モーダルを使わず、
// セグメントタブ(バーコード/AI/手動)で切り替える同じ構成のパネル。
// パネルを開くとダッシュボードの2つのボタンは隠れ、閉じると再表示される
// (パネルが上に詰まり、手動登録・消費でもスクロールしにくくなる)。
//
// 【重要】このファイルは見た目・表示切り替えの制御のみを行う。
// scan-btn / photo-btn / add-item-btn / consume-scan-btn / consume-photo-btn /
// manual-confirm-consume-btn などは、barcode.js / aiPhoto.js / items.js /
// consume.js に元々あるイベントリスナーがそのまま動作する
// (ここでは追加のリスナーを乗せて表示切り替えを制御するだけ)。
// ==========================================================

function show(id) { document.getElementById(id).classList.remove("hidden"); }
function hide(id) { document.getElementById(id).classList.add("hidden"); }

const dashboardGrid = document.querySelector(".dashboard-grid");
const registerSection = document.getElementById("register-accordion-section");
const consumeSection = document.getElementById("consume-accordion-section");

function selectTab(target) {
  document.querySelectorAll(".segmented-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.tabTarget === target);
  });
  document.querySelectorAll(".tab-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === "tab-panel-" + target);
  });
}

document.querySelectorAll(".segmented-tab").forEach(tab => {
  tab.addEventListener("click", () => selectTab(tab.dataset.tabTarget));
});

// ---------- 食材を登録 ----------

document.getElementById("open-register-modal-btn").addEventListener("click", () => {
  dashboardGrid.classList.add("hidden");
  hide("consume-accordion-section");
  show("register-accordion-section");
  selectTab("barcode");
  registerSection.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("close-register-accordion-btn").addEventListener("click", closeRegisterSection);

function closeRegisterSection() {
  hide("register-accordion-section");
  dashboardGrid.classList.remove("hidden");
  selectTab("barcode");
}

// 手動登録が成功したらパネルを閉じる
const manualAddMessageEl = document.getElementById("manual-add-message");
new MutationObserver(() => {
  if (manualAddMessageEl.classList.contains("msg-ok") && manualAddMessageEl.textContent) {
    setTimeout(closeRegisterSection, 700);
  }
}).observe(manualAddMessageEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });

// AIでの一括登録が完了(またはキャンセル)されたらパネルを閉じる
const reviewSectionEl = document.getElementById("review-section");
new MutationObserver(() => {
  if (reviewSectionEl.classList.contains("hidden")) closeRegisterSection();
}).observe(reviewSectionEl, { attributes: true, attributeFilter: ["class"] });

// ---------- 食材を消費 ----------

document.getElementById("open-consume-modal-btn").addEventListener("click", () => {
  dashboardGrid.classList.add("hidden");
  hide("register-accordion-section");
  show("consume-accordion-section");
  selectTab("consume-barcode");
  consumeSection.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.getElementById("close-consume-accordion-btn").addEventListener("click", closeConsumeSection);

function closeConsumeSection() {
  hide("consume-accordion-section");
  dashboardGrid.classList.remove("hidden");
  selectTab("consume-barcode");
}

// 手動消費が成功したらパネルを閉じる
const manualConsumeMessageEl = document.getElementById("manual-consume-message");
new MutationObserver(() => {
  if (manualConsumeMessageEl.classList.contains("msg-ok") && manualConsumeMessageEl.textContent) {
    setTimeout(closeConsumeSection, 700);
  }
}).observe(manualConsumeMessageEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });

// バーコード/AI経由の消費が確定(confirm-consume-btn)されたらパネルを閉じる
const consumeMessageEl = document.getElementById("consume-message");
new MutationObserver(() => {
  if (consumeMessageEl.classList.contains("msg-ok") && consumeMessageEl.textContent) {
    setTimeout(closeConsumeSection, 700);
  }
}).observe(consumeMessageEl, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });

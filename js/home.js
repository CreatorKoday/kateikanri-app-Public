// ==========================================================
// ホーム画面: アクションメニュー(6カード)から1タップで各機能を開く
//
// 「登録」「消費」の大きなボタン→方法選択、という2段階の導線を廃止し、
// バーコード登録/AI登録/手動登録/バーコード削除/AI削除/手動削除の
// 6つを常時ホーム画面に表示し、タップすると該当機能だけが直接開く。
//
// 【重要】このファイルは見た目・表示切り替えの制御のみを行う。
// scan-btn / photo-btn / add-item-btn / consume-scan-btn / consume-photo-btn /
// manual-confirm-consume-btn などは、barcode.js / aiPhoto.js / items.js /
// consume.js に元々あるイベントリスナーがそのまま動作する
// (ここでは追加のリスナーを乗せて表示切り替えを制御するだけ)。
// ==========================================================

function show(id) { document.getElementById(id).classList.remove("hidden"); }
function hide(id) { document.getElementById(id).classList.add("hidden"); }

const actionMenu = document.querySelector(".action-menu-grid");
const actionPanel = document.getElementById("action-panel-section");
const actionPanelTitle = document.getElementById("action-panel-title");

const PANEL_TITLES = {
  "barcode": "バーコードで登録",
  "ai": "AIで登録",
  "manual": "手動で登録",
  "consume-barcode": "バーコードで削除",
  "consume-ai": "AIで削除",
  "consume-manual": "手動で削除"
};

function selectPanel(target) {
  document.querySelectorAll(".tab-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === "tab-panel-" + target);
  });
  actionPanelTitle.textContent = PANEL_TITLES[target] || "";
}

function openActionPanel(target) {
  actionMenu.classList.add("hidden");
  show("action-panel-section");
  selectPanel(target);
  actionPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeActionPanel() {
  hide("action-panel-section");
  actionMenu.classList.remove("hidden");
}

document.querySelectorAll(".action-menu-card").forEach(card => {
  card.addEventListener("click", () => openActionPanel(card.dataset.target));
});
document.getElementById("close-action-panel-btn").addEventListener("click", closeActionPanel);

// ---------- 完了したら自動でパネルを閉じる ----------

function watchSuccessMessage(elId, onSuccess) {
  const el = document.getElementById(elId);
  new MutationObserver(() => {
    if (el.classList.contains("msg-ok") && el.textContent) {
      setTimeout(onSuccess, 700);
    }
  }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
}

watchSuccessMessage("manual-add-message", closeActionPanel);     // 手動登録の成功
watchSuccessMessage("manual-consume-message", closeActionPanel); // 手動削除の成功
watchSuccessMessage("consume-message", closeActionPanel);        // バーコード/AI削除の確定

// AIでの一括登録が完了(またはキャンセル)されたら閉じる
const reviewSectionEl = document.getElementById("review-section");
new MutationObserver(() => {
  if (reviewSectionEl.classList.contains("hidden")) closeActionPanel();
}).observe(reviewSectionEl, { attributes: true, attributeFilter: ["class"] });

// ==========================================================
// 画面切り替え(ホーム / 買い物リスト / 在庫確認)
// ==========================================================

import { loadShoppingList } from "./shopping.js";
import { loadItems } from "./items.js";

export function switchView(view) {
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  document.getElementById("view-" + view).classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  if (view === "shopping") loadShoppingList();
  if (view === "inventory") loadItems();
}

// 「戻る」ボタンなど、HTML側の onclick="switchView('home')" から呼べるようにする
window.switchView = switchView;

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// 「手動で登録」「手動で消費」はホーム画面内のタブに統合されたため、ここでの遷移は不要になった

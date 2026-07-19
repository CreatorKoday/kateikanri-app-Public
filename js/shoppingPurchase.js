// ==========================================================
// 買い物リストの「購入済み」→在庫登録
//
// 「購入済み」ボタン(data-action="mark-purchased")を監視し、商品名から
// 既存の items を確認したうえで、商品登録の手動フォーム(js/items.js の
// #register-overlay)をそのまま開き、商品名・単位・数量を買い物リストの
// 内容で初期値にする(手動登録と同じウィンドウを共有するため、専用のシートは持たない)。
// 登録が完了したら、対象の買い物リスト行の削除は js/items.js 側で行う。
// ==========================================================

import { supabaseClient } from "./config.js";
import { openRegisterManualOverlayForPurchase } from "./items.js";

// 検索している間に別の「購入済み」操作が割り込んでいたら、古い方の結果は反映しない
let openToken = 0;

async function openShoppingPurchase({ shoppingId, itemId, name, quantityNeeded }) {
  const myToken = ++openToken;

  // 在庫連動(item_id あり)ならそのまま、自由入力なら商品名で既存商品を検索する
  let item = null;
  if (itemId) {
    const { data } = await supabaseClient.from("items").select("id, name, unit").eq("id", itemId).maybeSingle();
    item = data || null;
  } else {
    const { data } = await supabaseClient.from("items").select("id, name, unit").eq("name", name).limit(1);
    item = data && data.length > 0 ? data[0] : null;
  }

  if (myToken !== openToken) return;

  openRegisterManualOverlayForPurchase({
    shoppingId,
    name: item ? item.name : (name || ""),
    unit: item ? item.unit : null,
    quantity: quantityNeeded || 1,
    isKnownItem: !!item
  });
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest('[data-action="mark-purchased"]');
  if (!btn) return;
  openShoppingPurchase({
    shoppingId: btn.dataset.id,
    itemId: btn.dataset.itemId || null,
    name: btn.dataset.name,
    quantityNeeded: Number(btn.dataset.quantity) || 1
  });
});

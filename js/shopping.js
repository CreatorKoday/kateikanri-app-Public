// ==========================================================
// 買い物リストまわり
// ==========================================================

import { supabaseClient } from "./config.js";
import { shoppingListEl } from "./elements.js";
import { escapeHtml } from "./utils.js";

// 在庫ロットの合計数量としきい値を見て、買い物リストへの追加/削除を自動で行う。
// low_stock_threshold が 0 の商品は、在庫が0でも自動追加の対象にしない
// (最低数量を「管理しない」という意思表示として扱う)
export async function syncShoppingListForItem(itemId) {
  const { data: item, error: itemError } = await supabaseClient
    .from("items")
    .select("id, name, low_stock_threshold")
    .eq("id", itemId)
    .single();
  if (itemError || !item) {
    console.error("商品情報の取得に失敗(買い物リスト同期):", itemError);
    return;
  }

  const { data: lots, error: lotsError } = await supabaseClient
    .from("item_lots")
    .select("quantity")
    .eq("item_id", itemId);
  if (lotsError) {
    console.error("在庫ロットの取得に失敗(買い物リスト同期):", lotsError);
    return;
  }
  const totalQuantity = (lots || []).reduce((sum, l) => sum + Number(l.quantity), 0);

  const { data: existingList, error: findError } = await supabaseClient
    .from("shopping_list")
    .select("id")
    .eq("item_id", itemId)
    .eq("is_purchased", false)
    .limit(1);

  if (findError) {
    console.error("買い物リストの検索に失敗:", findError);
    return;
  }
  const existing = existingList && existingList.length > 0 ? existingList[0] : null;

  const threshold = Number(item.low_stock_threshold);
  const isLow = threshold > 0 && totalQuantity < threshold;

  if (isLow && !existing) {
    const { error: insertError } = await supabaseClient.from("shopping_list").insert({
      item_id: item.id,
      name: item.name,
      quantity_needed: 1
    });
    if (insertError) console.error("買い物リストへの追加に失敗:", insertError);
  } else if (!isLow && existing) {
    const { error: deleteError } = await supabaseClient.from("shopping_list").delete().eq("id", existing.id);
    if (deleteError) console.error("買い物リストからの削除に失敗:", deleteError);
  }
}

// 前後の空白を除去し、全角/半角スペースの違いを吸収する(重複判定・保存の両方で使う)
function normalizeShoppingName(name) {
  return (name || "").replace(/[　\s]+/g, " ").trim();
}

// ホーム画面(手動登録・AI写真判定)から、在庫(item_id)とは紐付けずに買い物リストへ追加する。
// 在庫と紐付けないため、在庫の増減で誤って削除されることがない。
// 同じ商品名(空白の違いを除く)の未完了項目がすでにあれば、重複追加しない。
export async function addToShoppingList(rawName) {
  const name = normalizeShoppingName(rawName);
  if (!name) return { ok: false, reason: "empty" };

  const { data: dup, error: dupError } = await supabaseClient
    .from("shopping_list")
    .select("id")
    .eq("is_purchased", false)
    .eq("name", name)
    .limit(1);
  if (dupError) {
    console.error("買い物リストの重複確認に失敗:", dupError);
    return { ok: false, reason: "error" };
  }
  if (dup && dup.length > 0) return { ok: true, duplicate: true };

  const { error: insertError } = await supabaseClient.from("shopping_list").insert({
    item_id: null,
    name,
    quantity_needed: 1
  });
  if (insertError) {
    console.error("買い物リストへの追加に失敗:", insertError);
    return { ok: false, reason: "error" };
  }
  return { ok: true, duplicate: false };
}

export async function loadShoppingList() {
  const { data, error } = await supabaseClient
    .from("shopping_list")
    .select("*")
    .eq("is_purchased", false)
    .order("created_at", { ascending: true });

  if (error) {
    shoppingListEl.innerHTML = '<div class="empty-note">読み込みエラー: ' + error.message + '</div>';
    return;
  }
  renderShoppingList(data);
}

function renderShoppingList(rows) {
  if (!rows || rows.length === 0) {
    shoppingListEl.innerHTML = '<div class="empty-note">買い物リストは空です。在庫が少なくなると自動で追加されます。</div>';
    return;
  }

  shoppingListEl.innerHTML = rows.map(row => `
    <div class="shopping-card ${row.item_id ? "" : "manual"}">
      <button class="check-btn" data-action="mark-purchased" data-id="${row.id}" data-item-id="${row.item_id || ""}" data-quantity="${row.quantity_needed}" data-name="${escapeHtml(row.name)}"><span class="material-symbols-rounded">check</span></button>
      <div class="shopping-info">
        <div class="shopping-name">${escapeHtml(row.name)}</div>
        <div class="shopping-meta">数量 ${row.quantity_needed}${row.item_id ? " ・ 在庫連動" : ""}</div>
      </div>
      <button class="del-btn" data-action="remove-shopping-item" data-id="${row.id}"><span class="material-symbols-rounded">delete</span></button>
    </div>
  `).join("");

}

async function removeShoppingItem(id) {
  if (!confirm("このリストの項目を削除しますか?")) return;
  const { error } = await supabaseClient.from("shopping_list").delete().eq("id", id);
  if (!error) loadShoppingList();
}

// 「購入済み」(mark-purchased)は js/shoppingPurchase.js が独自に監視し、
// 在庫登録シートを開く(このファイルからは直接呼び出さない)

// カード内のボタンはloadShoppingList()のたびに再生成されるため、shoppingListElへの委譲で拾う
shoppingListEl.addEventListener("click", (e) => {
  const removeBtn = e.target.closest('[data-action="remove-shopping-item"]');
  if (removeBtn) removeShoppingItem(removeBtn.dataset.id);
});

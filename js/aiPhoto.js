// ==========================================================
// 写真によるAI商品判定(商品登録・複数商品一括登録)
// ==========================================================

import { GEMINI_API_KEY } from "./config.js";
import { addMessageBox, reviewMessageBox } from "./elements.js";
import { showMessage, escapeHtml, buildQuantityOptionsHtml, showAppNotice, productMasterStatusPrefix } from "./utils.js";
import { setupReviewQuantityToggle, isContinuousUnit, getReviewQuantityValue } from "./quantity.js";
import { upsertItemByName, openRegisterOverlay, closeRegisterOverlay } from "./items.js";
import { addToShoppingList } from "./shopping.js";

document.getElementById("photo-btn").addEventListener("click", () => {
  document.getElementById("photo-input").click();
});

document.getElementById("photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  showAppNotice("AIが商品を判定中です。少々お待ちください...");

  try {
    const base64Data = await fileToBase64(file);
    const items = await identifyProductsWithAI(base64Data, file.type);

    if (!items || items.length === 0) {
      showAppNotice("");
      showMessage(addMessageBox, "商品を判定できませんでした。商品名を手入力してください。", true);
      return;
    }

    showAppNotice("");
    renderReviewList(items);
  } catch (err) {
    showAppNotice("");
    showMessage(addMessageBox, "判定エラー: " + err.message, true);
  } finally {
    e.target.value = "";
  }
});

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function identifyProductsWithAI(base64Data, mimeType) {
  const prompt = "この写真に写っている食品・日用品をすべて識別してください。" +
    "商品名(name)は、パッケージに記載されている具体的な商品名(商品シリーズ名を含む)にしてください" +
    "(例:「バーモンドカレー辛口」「明治おいしい牛乳」)。「厳選」「濃厚」などの宣伝文句のみ除いてください。" +
    "パッケージの文字が読み取れない等、具体的な商品名を確実に判定できない場合は、無理に個別の商品名を作らず、" +
    "見た目から分かる一般的な呼び方(例:「カレールー」「牛乳」)にしてください。" +
    "同じ種類の商品が複数写っている場合は1つの項目にまとめて、その個数をquantityに入れてください。" +
    "違う商品ごとに別の項目として出力してください。" +
    "unitには個・本・パック・袋・箱など、その商品に自然な単位を日本語で入れてください。" +
    "商品が何も認識できない場合は空の配列を返してください。";

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Data } }
          ]
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                unit: { type: "STRING" },
                quantity: { type: "NUMBER" }
              },
              required: ["name", "unit", "quantity"]
            }
          }
        }
      })
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "AIとの通信に失敗しました");
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return [];

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("AIの応答を解析できませんでした");
  }
}

function renderReviewList(items) {
  const reviewSection = document.getElementById("review-section");
  const reviewList = document.getElementById("review-list");

  reviewList.innerHTML = items.map((item, index) => `
    <div class="review-card" data-index="${index}">
      <label>商品名</label>
      <input type="text" class="review-name" value="${escapeHtml(item.name || "")}">

      <div class="row2">
        <div class="review-type-fallback hidden">
          <label>種別</label>
          <select class="review-type">
            <option value="食品">食品</option>
            <option value="日用品">日用品</option>
          </select>
        </div>
        <div>
          <label>単位</label>
          <input type="text" class="review-unit" value="${escapeHtml(item.unit || "個")}">
        </div>
      </div>

      <div class="row2">
        <div>
          <label>数量</label>
          <select class="review-quantity ${isContinuousUnit(item.unit) ? "hidden" : ""}">${buildQuantityOptionsHtml(item.quantity || 1)}</select>
          <input type="number" class="review-quantity-numeric ${isContinuousUnit(item.unit) ? "" : "hidden"}" min="0" step="any" inputmode="decimal" placeholder="例: 500" value="${item.quantity || ""}">
        </div>
        <div>
          <label>消費・賞味期限(任意)</label>
          <input type="text" class="review-expiry date-display" placeholder="タップして選択" readonly>
        </div>
      </div>

      <p class="review-fallback-note msg-error hidden">商品属性を自動判定できませんでした。種別を選択してもう一度登録してください</p>

      <div class="review-card-actions">
        <button type="button" class="btn-secondary review-register-btn"><span class="material-symbols-rounded">check</span> 登録</button>
        <button type="button" class="btn-secondary review-add-shopping-btn"><span class="material-symbols-rounded">add_shopping_cart</span> 買い物へ</button>
        <button type="button" class="btn-secondary review-remove-btn"><span class="material-symbols-rounded">delete</span> 削除</button>
      </div>
    </div>
  `).join("");

  if (window.lucide) lucide.createIcons();

  reviewList.querySelectorAll(".review-card").forEach(card => setupReviewQuantityToggle(card));

  reviewList.querySelectorAll(".review-remove-btn").forEach(btn => {
    btn.addEventListener("click", () => removeReviewCard(btn.closest(".review-card")));
  });

  reviewList.querySelectorAll(".review-register-btn").forEach(btn => {
    btn.addEventListener("click", () => registerReviewCard(btn.closest(".review-card")));
  });

  reviewList.querySelectorAll(".review-add-shopping-btn").forEach(btn => {
    btn.addEventListener("click", () => addReviewCardToShoppingList(btn.closest(".review-card")));
  });

  document.getElementById("register-manual-section").classList.add("hidden");
  openRegisterOverlay();
  reviewSection.classList.remove("hidden");
  reviewSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

// カードが1件も残っていなければ、オーバーレイ自体を閉じる(まとめて登録完了時と同じ後処理)
function closeReviewIfEmpty() {
  if (document.querySelectorAll("#review-list .review-card").length === 0) {
    closeRegisterOverlay();
  }
}

// 「削除」: AIへの再問い合わせはせず、そのカードを画面から取り除くだけ
function removeReviewCard(card) {
  card.remove();
  closeReviewIfEmpty();
}

// カードの種別フォールバック欄が表示されていれば、その選択値をcategoryとして使う
// (商品マスタの自動判定に失敗し、手入力を求めている状態)
function readFallbackCategory(card) {
  const typeFallback = card.querySelector(".review-type-fallback");
  return typeFallback.classList.contains("hidden") ? undefined : card.querySelector(".review-type").value;
}

function showNeedsCategoryOnCard(card) {
  card.querySelector(".review-type-fallback").classList.remove("hidden");
  card.querySelector(".review-fallback-note").classList.remove("hidden");
}

// 「登録」: そのカード1件だけを登録する
async function registerReviewCard(card) {
  const name = card.querySelector(".review-name").value.trim();
  if (!name) {
    showMessage(reviewMessageBox, "商品名を入力してください", true);
    return;
  }

  const registerBtn = card.querySelector(".review-register-btn");
  registerBtn.disabled = true;

  const result = await upsertItemByName({
    name,
    category: readFallbackCategory(card),
    unit: card.querySelector(".review-unit").value.trim() || "個",
    quantity: parseFloat(getReviewQuantityValue(card)) || 0,
    expiry_date: card.querySelector(".review-expiry").value || null
  });

  registerBtn.disabled = false;

  if (result && result.needsCategory) {
    showNeedsCategoryOnCard(card);
    showMessage(reviewMessageBox, "「" + name + "」は商品属性を自動判定できませんでした。種別を選択してもう一度登録してください", true);
    return;
  }

  if (!result) {
    showMessage(reviewMessageBox, "登録に失敗しました。もう一度お試しください。", true);
    return;
  }

  card.remove();
  closeReviewIfEmpty();
  const message = productMasterStatusPrefix(result.productMasterStatus) + "「" + name + "」を登録しました";
  showMessage(addMessageBox, message, false);
  showAppNotice(message);
}

// 「買い物へ」: そのカード1件だけを買い物リストへ追加する(在庫ロットは作成・変更せず、AIへの再問い合わせもしない)
async function addReviewCardToShoppingList(card) {
  const name = card.querySelector(".review-name").value.trim();
  if (!name) {
    showMessage(reviewMessageBox, "商品名を入力してください", true);
    return;
  }

  const addBtn = card.querySelector(".review-add-shopping-btn");
  addBtn.disabled = true;
  const result = await addToShoppingList(name);
  addBtn.disabled = false;

  if (!result.ok) {
    showMessage(reviewMessageBox, "買い物リストへの追加に失敗しました。もう一度お試しください。", true);
    return;
  }

  card.remove();
  closeReviewIfEmpty();
  const message = result.duplicate ? `「${name}」はすでに買い物リストにあります` : `「${name}」を買い物リストに追加しました`;
  showMessage(addMessageBox, message, false);
  showAppNotice(message);
}

document.getElementById("cancel-review-btn").addEventListener("click", () => {
  closeRegisterOverlay();
});

document.getElementById("register-all-btn").addEventListener("click", async () => {
  const cards = document.querySelectorAll("#review-list .review-card");
  if (cards.length === 0) {
    showMessage(reviewMessageBox, "登録する商品がありません", true);
    return;
  }

  let count = 0;
  let generatedCount = 0;
  let reusedCount = 0;
  let needsCategoryCount = 0;
  const cardsToRemove = [];

  for (const card of cards) {
    const name = card.querySelector(".review-name").value.trim();
    if (!name) continue;

    const result = await upsertItemByName({
      name,
      category: readFallbackCategory(card),
      unit: card.querySelector(".review-unit").value.trim() || "個",
      quantity: parseFloat(getReviewQuantityValue(card)) || 0,
      expiry_date: card.querySelector(".review-expiry").value || null
    });

    if (result && result.needsCategory) {
      showNeedsCategoryOnCard(card);
      needsCategoryCount++;
      continue;
    }

    cardsToRemove.push(card);
    count++;
    if (result.productMasterStatus === "generated") generatedCount++;
    else if (result.productMasterStatus === "reused") reusedCount++;
  }

  if (count === 0 && needsCategoryCount === 0) {
    showMessage(reviewMessageBox, "商品名が入力されていません", true);
    return;
  }

  cardsToRemove.forEach(card => card.remove());

  // 種別の手入力が必要な商品が残っている間は、レビュー欄を閉じずそのまま個別修正できるようにする
  if (needsCategoryCount > 0) {
    showMessage(reviewMessageBox, needsCategoryCount + "件は種別を選択してもう一度登録してください(" + count + "件は登録済み)", true);
    return;
  }

  closeRegisterOverlay();

  const masterDetails = [];
  if (generatedCount > 0) masterDetails.push("AI生成" + generatedCount + "件");
  if (reusedCount > 0) masterDetails.push("既存利用" + reusedCount + "件");
  const message = count + "件登録しました" + (masterDetails.length > 0 ? "(" + masterDetails.join("・") + ")" : "");
  showMessage(addMessageBox, message, false);
  showAppNotice(message);
});

// 「まとめて買い物リストに追加」: その時点で画面に残っている全カードを買い物リストへ追加する
// (在庫ロットは作成・変更せず、AIへの再問い合わせもしない)
document.getElementById("add-all-to-shopping-btn").addEventListener("click", async () => {
  const cards = document.querySelectorAll("#review-list .review-card");
  if (cards.length === 0) {
    showMessage(reviewMessageBox, "追加する商品がありません", true);
    return;
  }

  let addedCount = 0;
  let duplicateCount = 0;

  for (const card of cards) {
    const name = card.querySelector(".review-name").value.trim();
    if (!name) continue;

    const result = await addToShoppingList(name);
    if (!result.ok) continue;
    if (result.duplicate) duplicateCount++; else addedCount++;
  }

  if (addedCount === 0 && duplicateCount === 0) {
    showMessage(reviewMessageBox, "商品名が入力されていません", true);
    return;
  }

  closeRegisterOverlay();

  const message = duplicateCount > 0
    ? `${addedCount}件を買い物リストに追加しました(${duplicateCount}件は追加済みでした)`
    : `${addedCount}件を買い物リストに追加しました`;
  showMessage(addMessageBox, message, false);
  showAppNotice(message);
});

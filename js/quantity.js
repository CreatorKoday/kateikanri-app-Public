// ==========================================================
// 単位に応じて「数量」をプルダウン⇔テンキー入力に切り替える
// ==========================================================

export const CONTINUOUS_UNITS = ["g", "ml", "kg", "l", "L"];

export function isContinuousUnit(unit) {
  return CONTINUOUS_UNITS.includes((unit || "").trim());
}

// レビューカード(写真AI判定)側の数量欄の切り替え
export function setupReviewQuantityToggle(card) {
  const unitInput = card.querySelector(".review-unit");
  const selectEl = card.querySelector(".review-quantity");
  const numEl = card.querySelector(".review-quantity-numeric");
  function refresh() {
    if (isContinuousUnit(unitInput.value)) {
      selectEl.classList.add("hidden");
      numEl.classList.remove("hidden");
    } else {
      selectEl.classList.remove("hidden");
      numEl.classList.add("hidden");
    }
  }
  unitInput.addEventListener("input", refresh);
  refresh();
}
export function getReviewQuantityValue(card) {
  const selectEl = card.querySelector(".review-quantity");
  const numEl = card.querySelector(".review-quantity-numeric");
  return numEl.classList.contains("hidden") ? selectEl.value : numEl.value;
}

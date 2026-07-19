// ==========================================================
// 4桁ドラムロール数量ピッカー ― 他のモジュールに依存しない独立部品
// 呼び出し元は openQuantityPicker({ initialValue, unit, title, onConfirm }) を呼ぶだけでよい
// ==========================================================

const ITEM_HEIGHT = 44;

const overlayEl = document.getElementById("quantity-picker-overlay");
const titleEl = document.getElementById("qty-picker-title");
const unitEl = document.getElementById("qty-picker-unit");
const wheelCols = Array.from(document.querySelectorAll("#qty-picker-wheels .qty-wheel-col"));

let confirmCallback = null;
const columnValues = [0, 0, 0, 0];
const settleTimers = [null, null, null, null];

function updateColumnVisual(col) {
  const colRect = col.getBoundingClientRect();
  const centerY = colRect.top + colRect.height / 2;
  col.querySelectorAll(".qty-wheel-item").forEach((item) => {
    const r = item.getBoundingClientRect();
    const dist = (r.top + r.height / 2 - centerY) / ITEM_HEIGHT;
    const absDist = Math.min(Math.abs(dist), 2.2);
    item.style.opacity = String(Math.max(1 - absDist * 0.32, 0.2));
    item.style.transform = `scale(${Math.max(1 - absDist * 0.14, 0.65)})`;
    item.classList.toggle("is-center", absDist < 0.4);
  });
}

function settleColumn(col, colIndex) {
  const index = Math.max(0, Math.min(9, Math.round(col.scrollTop / ITEM_HEIGHT)));
  columnValues[colIndex] = index;
  const targetTop = index * ITEM_HEIGHT;
  if (Math.abs(col.scrollTop - targetTop) > 1) {
    col.scrollTo({ top: targetTop, behavior: "smooth" });
  }
  updateColumnVisual(col);
}

function setColumnDigit(col, colIndex, digit) {
  columnValues[colIndex] = digit;
  col.scrollTop = digit * ITEM_HEIGHT;
  updateColumnVisual(col);
}

wheelCols.forEach((col, colIndex) => {
  col.addEventListener("scroll", () => {
    updateColumnVisual(col);
    clearTimeout(settleTimers[colIndex]);
    settleTimers[colIndex] = setTimeout(() => settleColumn(col, colIndex), 110);
  });
  col.querySelectorAll(".qty-wheel-item").forEach((item) => {
    item.addEventListener("click", () => {
      col.scrollTo({ top: Number(item.dataset.digit) * ITEM_HEIGHT, behavior: "smooth" });
    });
  });
});

// initialValue: 0〜9999の数量。unit/titleは表示のみに使う。onConfirm(value)は「完了」タップ時に呼ばれる
export function openQuantityPicker({ initialValue = 0, unit = "", title = "数量を選択", onConfirm } = {}) {
  confirmCallback = onConfirm || null;
  const clamped = Math.max(0, Math.min(9999, Math.round(Number(initialValue) || 0)));
  const digits = String(clamped).padStart(4, "0").split("").map(Number);

  titleEl.textContent = title;
  unitEl.textContent = unit || "";

  overlayEl.classList.remove("hidden");
  // オーバーレイが表示された直後(レイアウト確定後)でないとscrollTopの指定が効かない
  requestAnimationFrame(() => {
    wheelCols.forEach((col, i) => setColumnDigit(col, i, digits[i]));
  });
}

function closeQuantityPicker() {
  overlayEl.classList.add("hidden");
  confirmCallback = null;
}

document.getElementById("qty-picker-cancel-btn").addEventListener("click", closeQuantityPicker);

overlayEl.addEventListener("click", (e) => {
  if (e.target.id === "quantity-picker-overlay") closeQuantityPicker();
});

document.getElementById("qty-picker-done-btn").addEventListener("click", () => {
  const value = Number(columnValues.join(""));
  const cb = confirmCallback;
  closeQuantityPicker();
  if (cb) cb(value);
});

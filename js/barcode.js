// ==========================================================
// バーコードスキャン(登録用・消費用の両方に対応)
// ==========================================================

import { supabaseClient } from "./config.js";
import { addMessageBox } from "./elements.js";
import { showMessage } from "./utils.js";
import { updateUnitSuggestions } from "./units.js";
import { showConsumeReview } from "./consume.js";

let html5QrCode = null;
export let currentBarcodeValue = null;
export function resetCurrentBarcodeValue() {
  currentBarcodeValue = null;
}

let scanMode = "register"; // "register" または "consume"
let activeScannerWrapId = "scanner-wrap";

document.getElementById("scan-btn").addEventListener("click", () => startScanner("register"));
document.getElementById("close-scanner-btn").addEventListener("click", stopScanner);
document.getElementById("consume-scan-btn").addEventListener("click", () => startScanner("consume"));
document.getElementById("close-consume-scanner-btn").addEventListener("click", stopScanner);

async function startScanner(mode) {
  scanMode = mode;
  activeScannerWrapId = mode === "consume" ? "consume-scanner-wrap" : "scanner-wrap";
  const readerId = mode === "consume" ? "consume-reader" : "reader";

  document.getElementById(activeScannerWrapId).classList.remove("hidden");
  html5QrCode = new Html5Qrcode(readerId);
  const config = {
    fps: 10,
    qrbox: { width: 320, height: 200 },
    formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128
    ],
    videoConstraints: {
      facingMode: "environment",
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    }
  };
  try {
    await html5QrCode.start(
      { facingMode: "environment" },
      config,
      onScanSuccess,
      () => {}
    );
  } catch (err) {
    showMessage(addMessageBox, "カメラを起動できませんでした: " + (err && err.message ? err.message : err), true);
    document.getElementById(activeScannerWrapId).classList.add("hidden");
  }
}

async function stopScanner() {
  if (html5QrCode) {
    try { await html5QrCode.stop(); } catch (e) {}
    try { html5QrCode.clear(); } catch (e) {}
    html5QrCode = null;
  }
  document.getElementById(activeScannerWrapId).classList.add("hidden");
}

async function onScanSuccess(decodedText) {
  await stopScanner();
  if (scanMode === "consume") {
    showMessage(addMessageBox, "読み取りました(" + decodedText + ")。在庫を検索中...", false);
    await handleConsumeBarcode(decodedText);
  } else {
    currentBarcodeValue = decodedText;
    showMessage(addMessageBox, "読み取りました(" + decodedText + ")。商品情報を検索中...", false);
    await lookupBarcode(decodedText);
  }
}

async function lookupBarcode(barcode) {
  try {
    const res = await fetch("https://world.openfoodfacts.org/api/v2/product/" + barcode + ".json");
    const data = await res.json();
    if (data.status === 1 && data.product) {
      const name = data.product.product_name_ja || data.product.product_name || "";
      if (name) {
        document.getElementById("item-name").value = name;
        updateUnitSuggestions();
        showMessage(addMessageBox, "商品名を自動入力しました。「手動で登録」を開いて内容を確認してください。", false);
        return;
      }
    }
    showMessage(addMessageBox, "商品情報が見つかりませんでした。「手動で登録」から入力してください。", true);
  } catch (e) {
    showMessage(addMessageBox, "検索に失敗しました。「手動で登録」から入力してください。", true);
  }
}

// ---------- バーコードによる消費登録 ----------

async function handleConsumeBarcode(barcode) {
  const { data: byBarcode, error: barcodeError } = await supabaseClient
    .from("items")
    .select("id, name, unit, quantity")
    .eq("barcode", barcode)
    .limit(5);

  if (!barcodeError && byBarcode && byBarcode.length > 0) {
    showMessage(addMessageBox, "", false);
    showConsumeReview(byBarcode, "consume-review-list", "consume-review-section");
    return;
  }

  // バーコードだけでは見つからない場合、商品名を調べてから在庫を検索する
  try {
    const res = await fetch("https://world.openfoodfacts.org/api/v2/product/" + barcode + ".json");
    const data = await res.json();
    if (data.status === 1 && data.product) {
      const name = data.product.product_name_ja || data.product.product_name || "";
      if (name) {
        const { data: byName } = await supabaseClient
          .from("items").select("id, name, unit, quantity").ilike("name", "%" + name + "%").limit(5);
        if (byName && byName.length > 0) {
          showMessage(addMessageBox, "", false);
          showConsumeReview(byName, "consume-review-list", "consume-review-section");
          return;
        }
      }
    }
  } catch (e) {}

  showMessage(addMessageBox, "在庫にこの商品が見つかりませんでした。「手動で消費登録」からお試しください。", true);
}

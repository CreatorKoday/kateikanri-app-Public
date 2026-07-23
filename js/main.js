// ==========================================================
// エントリーポイント
// 各機能モジュールを読み込むことで、それぞれの中にある
// イベントリスナー登録などの初期化処理が実行される
// ==========================================================

import "./config.js";
import "./elements.js";
import "./utils.js";

import "./quantity.js";
import "./quantityPicker.js";
import "./units.js";

import "./shopping.js";
import "./items.js";
import "./productDetail.js";
import "./shoppingPurchase.js";

import "./aiPhoto.js";
import "./consume.js";

import "./navigation.js";
import "./auth.js";
import "./home.js";
import "./history.js";
import "./summary.js";
import "./balanceSheet.js";

import "./calendar.js";

// 静的に配置されているアイコン(ナビ・ボタンなど)を初期化する
if (window.lucide) lucide.createIcons();

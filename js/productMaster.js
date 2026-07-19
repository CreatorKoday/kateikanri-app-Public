// ==========================================================
// 商品マスタ(商品属性)の解決・キャッシュ
//
// ・normalized_name: 表記ゆれ(全角/半角・空白・容量表記など)を吸収するための
//   ローカル正規化キー。AI呼び出し前のキャッシュ判定に使う(product_name_alias)。
// ・canonicalName: AIが判定する、ブランドを問わない標準商品名。
//   属性(product_master)を複数ブランド間で共有するためのキー。
// ==========================================================

import { supabaseClient, GEMINI_API_KEY } from "./config.js";

export const FOOD_CATEGORIES = [
  "野菜","果物","肉","魚","乳製品","飲料","調味料","お菓子","パン","米","麺類",
  "冷凍食品","レトルト","缶詰","インスタント","その他"
];
export const DAILY_CATEGORIES = [
  "洗濯用品","掃除用品","キッチン用品","トイレ用品","お風呂用品","ティッシュ・紙製品",
  "衛生用品","スキンケア","ヘアケア","オーラルケア","ベビー用品","ペット用品",
  "消臭・芳香剤","電池・電球","その他"
];
export const FOOD_STORAGE_OPTIONS = ["常温", "冷蔵", "冷凍"];
export const DAILY_STORAGE_OPTIONS = ["洗面所", "キッチン", "トイレ", "浴室", "収納棚", "玄関", "その他"];
export const FOOD_USAGE_OPTIONS = ["朝食", "昼食", "夕食", "おやつ", "飲み物", "料理", "調味料"];
export const DAILY_USAGE_OPTIONS = ["掃除", "洗濯", "衛生", "美容", "生活用品"];

// 商品名の表記ゆれ(全角/半角・空白・容量表記など)を吸収するローカル正規化
export function normalizeProductName(raw) {
  let s = (raw || "").trim().normalize("NFKC");
  s = s.replace(/[\s・,、]+/g, "");
  s = s.replace(/\d+\s*(ml|l|kg|g|個|本|枚|袋|パック|入り?)/gi, "");
  return s.toLowerCase();
}

// カテゴリーからアイコン(絵文字)を決定する(商品ごとではなくカテゴリー単位で統一表示するため)
const CATEGORY_ICON_MAP = {
  "野菜": "🥬", "果物": "🍎", "肉": "🥩", "魚": "🐟", "乳製品": "🥛",
  "飲料": "🥤", "調味料": "🧂", "お菓子": "🍬", "パン": "🍞", "米": "🍚",
  "麺類": "🍜", "冷凍食品": "🧊", "レトルト": "🥫", "缶詰": "🥫", "インスタント": "🍲",
  "洗濯用品": "🧺", "掃除用品": "🧹", "キッチン用品": "🍳", "トイレ用品": "🚽",
  "お風呂用品": "🛁", "ティッシュ・紙製品": "🧻", "衛生用品": "🧼", "スキンケア": "🧴",
  "ヘアケア": "💇", "オーラルケア": "🪥", "ベビー用品": "🍼", "ペット用品": "🐾",
  "消臭・芳香剤": "🌸", "電池・電球": "🔋"
};
export function getCategoryIcon(type, category) {
  return CATEGORY_ICON_MAP[category] || (type === "食品" ? "🍽️" : "🧴");
}

function isCategoryValidForType(type, category) {
  const list = type === "食品" ? FOOD_CATEGORIES : DAILY_CATEGORIES;
  return list.includes(category);
}

// カテゴリーは固定リストから選ばれるため、ひらがな読みはAIに生成させず固定表で持つ
// (消費画面のひらがな検索用。AI呼び出し・追加トークンを増やさないため)
const CATEGORY_READING_MAP = {
  "野菜": "やさい", "果物": "くだもの", "肉": "にく", "魚": "さかな", "乳製品": "にゅうせいひん",
  "飲料": "いんりょう", "調味料": "ちょうみりょう", "お菓子": "おかし", "パン": "ぱん", "米": "こめ",
  "麺類": "めんるい", "冷凍食品": "れいとうしょくひん", "レトルト": "れとると", "缶詰": "かんづめ",
  "インスタント": "いんすたんと", "その他": "そのた",
  "洗濯用品": "せんたくようひん", "掃除用品": "そうじようひん", "キッチン用品": "きっちんようひん",
  "トイレ用品": "といれようひん", "お風呂用品": "おふろようひん", "ティッシュ・紙製品": "てぃっしゅかみせいひん",
  "衛生用品": "えいせいようひん", "スキンケア": "すきんけあ", "ヘアケア": "へあけあ",
  "オーラルケア": "おーらるけあ", "ベビー用品": "べびーようひん", "ペット用品": "ぺっとようひん",
  "消臭・芳香剤": "しょうしゅうほうこうざい", "電池・電球": "でんちでんきゅう"
};
export function getCategoryReading(category) {
  return CATEGORY_READING_MAP[category] || "";
}

// ひらがな(繰り返し記号「ー」含む)のみで構成されているか。標準商品名の読み仮名欄の
// 必須バリデーションに使う(漢字・カタカナ・空欄を弾く)
const HIRAGANA_PATTERN = /^[ぁ-んー]+$/;
export function isHiragana(str) {
  return HIRAGANA_PATTERN.test((str || "").trim());
}

// AIに商品属性(canonicalNameを含む)を問い合わせる。
// knownCanonicalNames は将来「既存の標準商品名を優先的に再利用する」仕組み
// (標準名辞書・RAG等)を追加する際の拡張ポイント。現時点では常に空配列で呼ばれ、
// プロンプトには反映されない。
async function identifyProductAttributes(rawName, knownCanonicalNames = []) {
  const knownNamesHint = knownCanonicalNames.length > 0
    ? "\n参考として、既存の標準商品名の候補: " + knownCanonicalNames.join("、") + "。該当するものがあれば優先的に使ってください。"
    : "";

  const prompt =
    "次の商品名から、商品属性をJSONで判定してください。商品名: 「" + rawName + "」\n" +
    "canonicalName(標準商品名)は、ブランド名や商品シリーズ名を除いた一般的な呼び方にしてください" +
    "(例: 「雪印牛乳」「明治おいしい牛乳」→「牛乳」、「ガーナミルク」→「チョコレート」、「アルフォート」→「クッキー」)。" +
    "typeは「食品」か「日用品」のどちらか一方にしてください。" +
    "categoryはtypeに応じて次のいずれか一つにしてください: " +
    "食品の場合は[" + FOOD_CATEGORIES.join("、") + "]、日用品の場合は[" + DAILY_CATEGORIES.join("、") + "]。" +
    "subCategoryはcategoryをさらに細かく分類してください。" +
    "storageはtypeに応じて次のいずれか一つにしてください: " +
    "食品の場合は[" + FOOD_STORAGE_OPTIONS.join("、") + "]、日用品の場合は[" + DAILY_STORAGE_OPTIONS.join("、") + "]。" +
    "usageはtypeに応じて次のいずれか一つにしてください: " +
    "食品の場合は[" + FOOD_USAGE_OPTIONS.join("、") + "]、日用品の場合は[" + DAILY_USAGE_OPTIONS.join("、") + "]。" +
    "searchKeywordsは検索やAI機能で使える関連キーワードを3〜8個返してください。" +
    "canonicalNameReading・subCategoryReadingには、それぞれcanonicalName・subCategoryの読み方を" +
    "ひらがなのみで入れてください(カタカナ・漢字・スペースは使わないでください)。" +
    "searchKeywordsReadingには、searchKeywordsの各要素に対応するひらがな読みを同じ順序・同じ件数で入れてください。" +
    "ブランド名ではなく商品の種類を優先して分類してください。" +
    knownNamesHint;

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              canonicalName: { type: "STRING" },
              canonicalNameReading: { type: "STRING" },
              type: { type: "STRING", enum: ["食品", "日用品"] },
              category: { type: "STRING", enum: [...FOOD_CATEGORIES, ...DAILY_CATEGORIES] },
              subCategory: { type: "STRING" },
              subCategoryReading: { type: "STRING" },
              storage: { type: "STRING", enum: [...FOOD_STORAGE_OPTIONS, ...DAILY_STORAGE_OPTIONS] },
              usage: { type: "STRING", enum: [...FOOD_USAGE_OPTIONS, ...DAILY_USAGE_OPTIONS] },
              searchKeywords: { type: "ARRAY", items: { type: "STRING" } },
              searchKeywordsReading: { type: "ARRAY", items: { type: "STRING" } }
            },
            required: ["canonicalName", "canonicalNameReading", "type", "category", "searchKeywords", "searchKeywordsReading"]
          }
        }
      })
    }
  );

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "商品属性の判定に失敗しました");
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("商品属性を判定できませんでした");
  return JSON.parse(text);
}

// 2文字ずつの文字集合(bigram)を作る。日本語は分かち書きが無いため、
// 簡易的な文字列類似度判定にはbigram+重なり係数を使う
function bigrams(str) {
  const s = str || "";
  if (s.length <= 1) return s ? [s] : [];
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.substring(i, i + 2));
  return grams;
}

// 2つの文字列の類似度を0〜1で返す(重なり係数 = 一致数 / 短い方のbigram数)。
// 「明治おいしい牛乳」と標準商品名「牛乳」のように長さの差が大きい組み合わせでも、
// 短い方(標準商品名側)がほぼ含まれていれば高いスコアになるようにしている
// (両者の合計で割るDice係数だと、ブランド名部分の長さに埋もれて低く出すぎるため)
function overlapSimilarity(a, b) {
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  if (gramsA.length === 0 || gramsB.length === 0) return 0;

  const remaining = new Map();
  gramsB.forEach(g => remaining.set(g, (remaining.get(g) || 0) + 1));

  let matches = 0;
  gramsA.forEach(g => {
    const count = remaining.get(g) || 0;
    if (count > 0) {
      matches++;
      remaining.set(g, count - 1);
    }
  });

  return matches / Math.min(gramsA.length, gramsB.length);
}

// 類似度の採否ライン・候補の上限件数(実運用の様子を見て調整する想定の暫定値)
const CANONICAL_CANDIDATE_SIMILARITY_THRESHOLD = 0.4;
const CANONICAL_CANDIDATE_MAX_COUNT = 5;

// 既存の商品マスタ(標準商品名・検索キーワード)の中から、文字列類似度が高いものだけを
// 数件に絞ってAIへのヒントとして返す。ここでの絞り込みはAIを呼ばずローカルで行うため、
// AI呼び出し回数は増やさない(「豚小間切れ」→既存の「豚小間切れ肉」のような表記ゆれを
// AIが同じ標準商品名として再利用しやすくするための下準備)
async function fetchKnownCanonicalNameCandidates(rawName) {
  const normalizedRaw = normalizeProductName(rawName);
  if (!normalizedRaw) return [];

  const { data, error } = await supabaseClient
    .from("product_master")
    .select("canonical_name, search_keywords");
  if (error || !data || data.length === 0) return [];

  const scored = data.map(row => {
    const nameScore = overlapSimilarity(normalizedRaw, normalizeProductName(row.canonical_name));
    const keywordScore = (row.search_keywords || []).reduce(
      (max, keyword) => Math.max(max, overlapSimilarity(normalizedRaw, normalizeProductName(keyword))),
      0
    );
    return { canonicalName: row.canonical_name, score: Math.max(nameScore, keywordScore) };
  });

  const candidates = scored
    .filter(s => s.score >= CANONICAL_CANDIDATE_SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .map(s => s.canonicalName);

  return Array.from(new Set(candidates)).slice(0, CANONICAL_CANDIDATE_MAX_COUNT);
}

// 商品名(生の表記)から商品マスタ行を解決する。
// 既知の表記(表記ゆれ込み)ならAIを呼ばずキャッシュ(product_name_alias)を返す。
// 失敗した場合は null を返し、呼び出し側は product_master_id なしで在庫登録を継続できる。
// 成功時は { master, generatedNew } を返す。generatedNew は、新しくAIに商品属性を
// 生成させた場合だけ true(キャッシュヒット・既存の標準商品名への合流は false)。
// 呼び出し側が「AIが商品属性を生成しました」/「既存の商品属性を利用しました」の
// どちらを表示するかの判定に使う。
//
// forceRegenerate: true の場合、キャッシュ確認をスキップし常にAIへ問い合わせる。
// 「商品属性が未設定の商品に新規作成する」場合と、将来の「既存の商品属性を
// 再生成する」機能(AIモデル変更時・分類ルール改善時など)の両方から、
// この同じ関数を共通の入口として使える設計にしている。
// なお、AIが既存の標準商品名(canonicalName)と同じ判定を返した場合は、その
// 既存のproduct_master行(ユーザーによる編集済みの内容を含む)がそのまま
// 再利用されるため、再生成であっても編集内容が上書きされることはない。
export async function resolveProductMaster(rawName, { forceRegenerate = false } = {}) {
  const normalized = normalizeProductName(rawName);
  if (!normalized) return null;

  try {
    if (!forceRegenerate) {
      const { data: existingAlias } = await supabaseClient
        .from("product_name_alias")
        .select("product_master_id")
        .eq("normalized_name", normalized)
        .maybeSingle();

      if (existingAlias) {
        const { data: master } = await supabaseClient
          .from("product_master")
          .select("*")
          .eq("id", existingAlias.product_master_id)
          .maybeSingle();
        if (master) return { master, generatedNew: false };
      }
    }

    const knownNames = await fetchKnownCanonicalNameCandidates(rawName);
    const attrs = await identifyProductAttributes(rawName, knownNames);

    if (!isCategoryValidForType(attrs.type, attrs.category)) {
      attrs.category = "その他";
    }

    const canonicalNormalized = normalizeProductName(attrs.canonicalName);

    let master = null;
    let generatedNew = false;
    const { data: existingMaster } = await supabaseClient
      .from("product_master")
      .select("*")
      .eq("canonical_normalized_name", canonicalNormalized)
      .maybeSingle();

    if (existingMaster) {
      master = existingMaster;
    } else {
      const { data: inserted, error: insertError } = await supabaseClient
        .from("product_master")
        .insert({
          canonical_name: attrs.canonicalName,
          canonical_normalized_name: canonicalNormalized,
          canonical_name_reading: attrs.canonicalNameReading || null,
          type: attrs.type,
          category: attrs.category,
          sub_category: attrs.subCategory || null,
          sub_category_reading: attrs.subCategoryReading || null,
          storage: attrs.storage || null,
          usage: attrs.usage || null,
          search_keywords: attrs.searchKeywords || [],
          search_keywords_reading: attrs.searchKeywordsReading || [],
          ai_model: "gemini-3.1-flash-lite"
        })
        .select()
        .single();

      if (insertError) {
        // 同時登録などで既に他方が作成済みの場合は、それを取得して使う(この場合は新規生成ではなく既存流用扱い)
        const { data: fallback } = await supabaseClient
          .from("product_master")
          .select("*")
          .eq("canonical_normalized_name", canonicalNormalized)
          .maybeSingle();
        master = fallback;
      } else {
        master = inserted;
        generatedNew = true;
      }
    }

    if (!master) return null;

    // forceRegenerate時は同じ表記のエイリアスが既に存在し得るため、
    // 単純なinsertではなくupsertで「あれば紐付け先を更新、なければ新規作成」にする
    await supabaseClient
      .from("product_name_alias")
      .upsert(
        { normalized_name: normalized, raw_name: rawName, product_master_id: master.id },
        { onConflict: "normalized_name" }
      );

    return { master, generatedNew };
  } catch (e) {
    console.error("商品マスタの解決に失敗:", e);
    return null;
  }
}

// ユーザーによる手動編集を product_master に反映する(AIへの再問い合わせは行わない)。
// changes に含まれるキーだけを更新し、そのキー名を edited_fields に記録することで、
// どの項目がAI初期値のままで、どの項目がユーザーによって変更されたかを区別できるようにする。
// changes のキー: icon / category / subCategory / storage / usage / searchKeywords /
//               canonicalName / canonicalNameReading
// 注意: canonicalName(表示名)を変更しても canonical_normalized_name(将来AIが同じ標準商品名と
// 判定した際に既存マスタを再利用するための照合キー)は変更しない。ここを一緒に書き換えると、
// 以後AIが元の判定を返すたびに一致しなくなり、毎回新しいマスタが作られてしまうため。
export async function updateProductMasterFields(id, changes) {
  const { data: current, error: fetchError } = await supabaseClient
    .from("product_master")
    .select("edited_fields")
    .eq("id", id)
    .maybeSingle();
  if (fetchError || !current) {
    console.error("商品マスタの取得に失敗:", fetchError);
    return null;
  }

  const nextEditedFields = Array.from(new Set([...(current.edited_fields || []), ...Object.keys(changes)]));

  const payload = {
    updated_at: new Date().toISOString(),
    edited_fields: nextEditedFields,
    source: "manual"
  };
  if (changes.icon !== undefined) payload.icon = changes.icon || null;
  if (changes.category !== undefined) payload.category = changes.category;
  if (changes.subCategory !== undefined) payload.sub_category = changes.subCategory || null;
  if (changes.storage !== undefined) payload.storage = changes.storage || null;
  if (changes.usage !== undefined) payload.usage = changes.usage || null;
  if (changes.searchKeywords !== undefined) payload.search_keywords = changes.searchKeywords;
  if (changes.canonicalName !== undefined) payload.canonical_name = changes.canonicalName;
  if (changes.canonicalNameReading !== undefined) payload.canonical_name_reading = changes.canonicalNameReading;

  const { data: updated, error: updateError } = await supabaseClient
    .from("product_master")
    .update(payload)
    .eq("id", id)
    .select()
    .single();

  if (updateError) {
    console.error("商品マスタの更新に失敗:", updateError);
    return null;
  }
  return updated;
}

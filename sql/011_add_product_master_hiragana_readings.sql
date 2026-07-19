-- 消費画面の検索でひらがな入力にも対応するため、product_master にひらがな読みの列を追加する。
-- カテゴリーは固定リストのためコード側の対応表(js/productMaster.jsのCATEGORY_READING_MAP)で
-- 賄い、ここではAIが自由に生成する項目(標準商品名・サブカテゴリー・検索キーワード)だけを追加する。
--
-- 既存行はこの時点でNULL/空配列になる。過去分の一括生成は行わず、標準商品名の編集や
-- 「商品属性を再生成」を行った時点で順次埋まっていく想定。

begin;

alter table product_master
  add column canonical_name_reading text,
  add column sub_category_reading text,
  add column search_keywords_reading text[] not null default '{}';

commit;

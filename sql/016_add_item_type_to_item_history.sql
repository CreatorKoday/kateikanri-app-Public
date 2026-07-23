-- 購入履歴に種別(食品/日用品)の列を追加する。他のスナップショット列
-- (item_name・canonical_name)と同じく、記録した時点の値をそのまま保存する
-- (商品や商品マスタを後から削除・変更しても履歴の表示が変わらないようにするため)

begin;

alter table item_history
  add column item_type text;

commit;

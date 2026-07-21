-- 食費・日用品費の計算確認のため、購入時の価格を記録できるようにする。
-- 価格は購入のたびに変わりうるため、商品(items)ではなくロット(item_lots、購入時点の記録)に持たせる。
-- 未入力のロットもあるためnullを許容する。

begin;

alter table item_lots
  add column price numeric;

commit;

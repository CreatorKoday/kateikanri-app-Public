-- 購入・消費履歴(ホーム画面の「購入履歴」ページ)を記録するためのテーブルを新設する。
-- item_lots は消費して数量が0になると行ごと削除され、購入時も既存ロットへ数量を加算する
-- 場合があるため、それ自体は「今の在庫状態」であって履歴ではない。増減のたびに
-- このテーブルへ1行追記していく、追記専用のログとして扱う。
--
-- item_id / product_master_id は商品や商品マスタを削除しても履歴自体は残したいため
-- on delete set null にし、削除後も読めるよう item_name / canonical_name をその時点の
-- スナップショットとして持つ。item_lots と同じ信頼境界(現状RLSなしで運用)に合わせ、
-- 今回はRLSを設定しない。

begin;

create table item_history (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid references items(id) on delete set null,
  item_name          text not null,
  product_master_id  uuid references product_master(id) on delete set null,
  canonical_name     text,
  event_type         text not null check (event_type in ('purchase', 'consumption')),
  quantity           numeric not null,
  unit               text not null,
  price              numeric,
  occurred_at        timestamptz not null default now()
);

create index idx_item_history_occurred_at on item_history (occurred_at desc);

commit;

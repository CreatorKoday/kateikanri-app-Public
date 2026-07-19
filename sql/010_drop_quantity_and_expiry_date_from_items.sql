-- items.quantity / items.expiry_date は item_lots への移行が完了し、コードから参照されなくなったため削除する
ALTER TABLE items DROP COLUMN IF EXISTS quantity;
ALTER TABLE items DROP COLUMN IF EXISTS expiry_date;

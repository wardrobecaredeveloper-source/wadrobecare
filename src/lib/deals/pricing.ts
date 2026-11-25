import { PriceRange, Sale, SaleItem } from './types';

/** Sale price = price less pct, rounded to the nearest roundTo (₦50). All amounts stay whole naira. */
export function salePrice(price: number, pct: number, roundTo = 50): number {
  const raw = price * (1 - pct / 100);
  return Math.round(raw / roundTo) * roundTo;
}
export const itemPct = (sale: Pick<Sale, 'pct'>, item: SaleItem): number => item.pct ?? sale.pct;
export function discountPercent(was: number, now: number): number { return was > 0 && now < was ? Math.round((1 - now / was) * 100) : 0; }
/** Price by size range, same shape the product page already uses (salePrice per range). */
export function saleRanges(ranges: PriceRange[], pct: number, roundTo = 50) {
  return ranges.map(r => ({ ...r, salePrice: salePrice(r.price, pct, roundTo) }));
}

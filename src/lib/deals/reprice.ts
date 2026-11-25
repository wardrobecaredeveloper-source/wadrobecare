import { DealSettings, Sale, SaleProduct } from './types';
import { itemPct, salePrice } from './pricing';
import { inForce } from './status';

/** The sale price in force for a product right now, or null. Used by the product page, cart, checkout and payment. */
export function saleFor(productId: string, sales: Sale[], now: Date) {
  for (const s of sales) if (inForce(s, now)) { const it = s.items.find(i => i.productId === productId); if (it) return { sale: s, item: it }; }
  return null;
}
export function currentPrice(p: SaleProduct, size: string | null, sales: Sale[], now: Date, st: DealSettings) {
  const base = (size ? p.ranges.find(r => rangeHas(p, r, size)) : null)?.price ?? p.priceLow;
  const hit = saleFor(p.id, sales, now);
  if (!hit) return { was: base, now: base, onSale: false, saleId: null as string | null };
  const now$ = salePrice(base, itemPct(hit.sale, hit.item), st.roundTo);
  return now$ < base ? { was: base, now: now$, onSale: true, saleId: hit.sale.id } : { was: base, now: base, onSale: false, saleId: null };
}
const rangeHas = (p: SaleProduct, r: { fromSize: string; toSize: string }, size: string) => { const i = p.sizes.indexOf(size); return i >= p.sizes.indexOf(r.fromSize) && i <= p.sizes.indexOf(r.toSize) && i >= 0; };

/** At checkout and again at payment: compare what the customer saw with what is true now. */
export function repriceLine(seen: number, p: SaleProduct, size: string | null, sales: Sale[], now: Date, st: DealSettings) {
  const cur = currentPrice(p, size, sales, now, st);
  if (cur.now === seen) return { changed: false as const, price: seen };
  return { changed: true as const, price: cur.now, was: seen, reason: (cur.onSale ? 'SALE_PRICE_CHANGED' : 'SALE_ENDED') as 'SALE_PRICE_CHANGED' | 'SALE_ENDED' };
}

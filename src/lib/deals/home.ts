import { DealSettings, Reason, Sale, SaleProduct } from './types';
import { itemPct, salePrice } from './pricing';
import { inForce } from './status';

export interface HomeCard { productId: string; name: string; category: string; was: number; now: number; percent: number; reasonLabel: string; flaw: boolean; low: number | null; fromPrice: boolean }
export interface HomeDeals {
  show: boolean; hiddenReason?: 'NO_SALE' | 'FEW_ITEMS';
  saleId?: string; kind?: Sale['kind']; headline?: string; strip?: string; announcement?: string;
  endsAt?: string | null; showCountdown?: boolean; totalItems?: number; cards: HomeCard[]; skipped: { productId: string; why: 'SOLD_OUT' | 'FLAW_OFF_HOME' | 'NO_ROOM' }[];
}

/** Which sale drives the band: a timed sale if one is in force (the one ending first), otherwise clearance. */
export function pickHomeSale(sales: Sale[], now: Date): Sale | null {
  const live = sales.filter(s => s.home && inForce(s, now));
  const timed = live.filter(s => s.kind === 'CAMPAIGN').sort((a, b) => new Date(a.endsAt!).getTime() - new Date(b.endsAt!).getTime());
  return timed[0] ?? live.find(s => s.kind === 'CLEARANCE') ?? null;
}

/** Mockup 64: in stock only; flaw items only if allowed; pinned first, then biggest discount, then id; at most 4; fewer than 3 hides the band. */
export function pickHomeDeals(sales: Sale[], products: SaleProduct[], reasons: Reason[], now: Date, s: DealSettings): HomeDeals {
  const sale = pickHomeSale(sales, now);
  if (!sale) return { show: false, hiddenReason: 'NO_SALE', cards: [], skipped: [] };
  const skipped: HomeDeals['skipped'] = []; const pool: (HomeCard & { pin: boolean })[] = [];
  for (const it of sale.items) {
    const p = products.find(x => x.id === it.productId); if (!p) continue;
    const r = reasons.find(x => x.id === it.reasonId);
    if (p.stock <= 0) { skipped.push({ productId: p.id, why: 'SOLD_OUT' }); continue; }
    if (r?.type === 'FLAW' && !sale.allowFlawOnHome) { skipped.push({ productId: p.id, why: 'FLAW_OFF_HOME' }); continue; }
    const pct = itemPct(sale, it), now$ = salePrice(p.priceLow, pct, s.roundTo);
    pool.push({ productId: p.id, name: p.name, category: p.category, was: p.priceLow, now: now$, percent: Math.round((1 - now$ / p.priceLow) * 100), reasonLabel: r?.label ?? '', flaw: r?.type === 'FLAW', low: p.stock <= 3 ? p.stock : null, fromPrice: p.priceLow !== p.priceHigh, pin: sale.pins.includes(p.id) });
  }
  pool.sort((a, b) => Number(b.pin) - Number(a.pin) || b.percent - a.percent || a.productId.localeCompare(b.productId));
  const cards = pool.slice(0, s.homeMaxCards).map(({ pin, ...c }) => c);
  pool.slice(s.homeMaxCards).forEach(c => skipped.push({ productId: c.productId, why: 'NO_ROOM' }));
  if (cards.length < s.homeMinItems) return { show: false, hiddenReason: 'FEW_ITEMS', saleId: sale.id, cards: [], skipped };
  return { show: true, saleId: sale.id, kind: sale.kind, headline: sale.headline, strip: sale.strip, announcement: sale.announcement, endsAt: sale.kind === 'CAMPAIGN' ? sale.endsAt : null, showCountdown: sale.countdown, totalItems: sale.items.length, cards, skipped };
}

/** Under 72 hours: a clock. Last 24 hours: urgent. Before that: the end date. */
export function countdownView(endsAt: string | null, now: Date, s: Pick<DealSettings, 'countdownHours' | 'urgentHours'>) {
  if (!endsAt) return { mode: 'NONE' as const, text: '' };
  const ms = new Date(endsAt).getTime() - now.getTime(); if (ms <= 0) return { mode: 'NONE' as const, text: '' };
  const h = ms / 3_600_000; const pad = (n: number) => String(n).padStart(2, '0');
  if (h >= s.countdownHours) return { mode: 'DATE' as const, text: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Lagos' }).format(new Date(endsAt)) };
  const sec = Math.floor(ms / 1000), d = Math.floor(sec / 86400), hh = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60;
  return { mode: h < s.urgentHours ? 'URGENT' as const : 'CLOCK' as const, text: d > 0 ? `${d}d ${pad(hh)}h` : `${pad(hh)}:${pad(m)}:${pad(x)}` };
}

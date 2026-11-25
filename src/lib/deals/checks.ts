import { DealSettings, Issue, IssueCode, Reason, Sale, SaleProduct } from './types';
import { itemPct, salePrice } from './pricing';
import { findConflicts } from './status';

/** The Review step (Mockup 65, step 5). Anything BAD blocks Publish, Schedule and Send for approval. WARN does not. */
export function checkSale(sale: Sale, products: SaleProduct[], reasons: Reason[], others: Sale[], s: DealSettings, now: Date): Issue[] {
  const out: Issue[] = [];
  const add = (level: Issue['level'], step: Issue['step'], code: IssueCode, message: string, productId?: string) => out.push({ level, step, code, message, productId });
  const prod = (id: string) => products.find(p => p.id === id);
  const reason = (id: string | null) => reasons.find(r => r.id === id);

  if (!sale.name.trim()) add('BAD', 1, 'NAME_MISSING', 'Give the sale a name.');
  if (sale.kind === 'CAMPAIGN') {
    if (!sale.startsAt || !sale.endsAt) add('BAD', 1, 'DATES_MISSING', 'A timed sale needs a start and an end.');
    else if (new Date(sale.endsAt) <= new Date(sale.startsAt)) add('BAD', 1, 'END_BEFORE_START', 'The end must be after the start.');
    else if (new Date(sale.endsAt) <= now) add('BAD', 1, 'END_IN_PAST', 'The end is in the past.');
  }
  if (sale.home && !sale.headline.trim()) add('BAD', 1, 'HEADLINE_MISSING', 'Homepage headline is empty.');
  if (!sale.items.length) add('BAD', 2, 'NO_ITEMS', 'Choose at least one item.');

  for (const c of findConflicts(sale, others, now))
    add('BAD', 2, 'CONFLICT', `${prod(c.productId)?.name ?? c.productId} is already in "${c.otherName}" at the same time.`, c.productId);

  for (const it of sale.items) {
    const p = prod(it.productId); if (!p) continue;
    const pct = itemPct(sale, it);
    if (!p.weightG) add('BAD', 2, 'NO_WEIGHT', `${p.name} has no delivery weight.`, p.id);
    if (p.stock <= 0) add('WARN', 2, 'SOLD_OUT', `${p.name} is sold out. It stays in the sale but will not be shown.`, p.id);
    if (pct < s.minPercent || pct > s.maxPercent) add('BAD', 3, 'PERCENT_RANGE', `${p.name}: discount must be between ${s.minPercent}% and ${s.maxPercent}%.`, p.id);
    else if (salePrice(p.priceLow, pct, s.roundTo) >= p.priceLow) add('BAD', 3, 'NO_REDUCTION', `${p.name}: the sale price does not go below the normal price.`, p.id);
    else if (pct > s.ownerOnlyAbove) add('WARN', 3, 'PERCENT_HIGH', `${p.name}: ${pct}% is above ${s.ownerOnlyAbove}%. Only the owner can publish this.`, p.id);
    const r = reason(it.reasonId);
    if (!it.reasonId) add('BAD', 3, 'NO_REASON', `${p.name}: choose a reason.`, p.id);
    else if (!r || !r.active) add('BAD', 3, 'REASON_OFF', `${p.name}: the reason is switched off.`, p.id);
    else if (r.type === 'FLAW') {
      if (it.note.trim().length < 15) add('BAD', 3, 'FLAW_NOTE', `${p.name}: describe the flaw in at least a short sentence.`, p.id);
      if (!it.flawPhotoUrl) add('BAD', 3, 'FLAW_PHOTO', `${p.name}: attach a photo of the flaw.`, p.id);
    }
  }
  if (sale.home) {
    const shown = sale.items.filter(it => (prod(it.productId)?.stock ?? 0) > 0 && (sale.allowFlawOnHome || reason(it.reasonId)?.type !== 'FLAW')).length;
    if (shown < s.homeMinItems) add('WARN', 4, 'HOME_FEW', `Only ${shown} item${shown === 1 ? '' : 's'} can appear on the homepage. With fewer than ${s.homeMinItems} the band is left out.`);
  }
  return out;
}
export const blockers = (issues: Issue[]) => issues.filter(i => i.level === 'BAD');

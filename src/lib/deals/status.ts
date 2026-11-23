import { Sale, SaleStatus } from './types';

const t = (s: string | null) => (s ? new Date(s).getTime() : null);

/** True while the sale's prices apply. Needs no background job: it only compares the clock with the sale's own times. */
export function inForce(sale: Sale, now: Date): boolean {
  if (sale.status !== 'SCHEDULED' && sale.status !== 'LIVE') return false;
  if (sale.endedAt && t(sale.endedAt)! <= now.getTime()) return false;
  const start = t(sale.startsAt); if (start === null || start > now.getTime()) return false;
  if (sale.kind === 'CAMPAIGN') { const end = t(sale.endsAt); if (end === null || end <= now.getTime()) return false; }
  return true;
}
export function effectiveStatus(sale: Sale, now: Date): SaleStatus {
  if (sale.status === 'DRAFT' || sale.status === 'PENDING') return sale.status;
  if (sale.endedAt && t(sale.endedAt)! <= now.getTime()) return 'ENDED';
  if (sale.kind === 'CAMPAIGN' && sale.endsAt && t(sale.endsAt)! <= now.getTime()) return 'ENDED';
  if (sale.status === 'ENDED') return 'ENDED';
  const start = t(sale.startsAt);
  return start !== null && start <= now.getTime() ? 'LIVE' : 'SCHEDULED';
}
const FAR = Number.MAX_SAFE_INTEGER;
const span = (s: Sale): [number, number] => [t(s.startsAt) ?? FAR, s.kind === 'CLEARANCE' || !s.endsAt ? FAR : t(s.endsAt)!];
export const overlaps = (a: Sale, b: Sale) => { const [as, ae] = span(a), [bs, be] = span(b); return as <= be && bs <= ae; };

/** Items that sit in another draft-excluded, not-ended sale during the same time. One item may be in one sale at a time. */
export function findConflicts(sale: Sale, others: Sale[], now: Date): { productId: string; otherId: string; otherName: string }[] {
  const out: { productId: string; otherId: string; otherName: string }[] = [];
  for (const o of others) {
    if (o.id === sale.id || o.status === 'DRAFT' || effectiveStatus(o, now) === 'ENDED') continue;
    if (!sale.startsAt && sale.kind !== 'CLEARANCE') continue;
    if (!overlaps(sale, o)) continue;
    for (const it of sale.items) if (o.items.some(x => x.productId === it.productId)) out.push({ productId: it.productId, otherId: o.id, otherName: o.name });
  }
  return out;
}

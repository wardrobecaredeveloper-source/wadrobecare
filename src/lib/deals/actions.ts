import { Issue, Role, Sale, SaleActionName, SaleError, SaleEvent, SaleItem } from './types';
import { effectiveStatus, findConflicts } from './status';
import { itemPct } from './pricing';

/** Who may do what (Mockup 65, Roles & access). The server checks this on every call. */
export const CAN: Record<Role, Record<SaleActionName, boolean>> = {
  OWNER:        { SAVE_DRAFT: true,  SUBMIT: true,  PUBLISH: true,  SEND_BACK: true,  END_NOW: true,  EXTEND: true,  REMOVE_ITEM: true,  ADD_ITEMS: true,  DELETE_DRAFT: true },
  MERCHANDISER: { SAVE_DRAFT: true,  SUBMIT: true,  PUBLISH: false, SEND_BACK: false, END_NOW: false, EXTEND: false, REMOVE_ITEM: false, ADD_ITEMS: false, DELETE_DRAFT: true },
  FRONTDESK:    { SAVE_DRAFT: false, SUBMIT: false, PUBLISH: false, SEND_BACK: false, END_NOW: false, EXTEND: false, REMOVE_ITEM: false, ADD_ITEMS: false, DELETE_DRAFT: false },
};
/** From which stored status each action is allowed. */
const FROM: Record<SaleActionName, string[]> = {
  SAVE_DRAFT: ['DRAFT'], SUBMIT: ['DRAFT'], PUBLISH: ['DRAFT', 'PENDING'], SEND_BACK: ['PENDING'],
  END_NOW: ['LIVE'], EXTEND: ['LIVE'], REMOVE_ITEM: ['LIVE'], ADD_ITEMS: ['LIVE', 'SCHEDULED'], DELETE_DRAFT: ['DRAFT'],
};
export interface ActionInput { issues: Issue[]; ownerOnlyAbove: number; note?: string; newEndsAt?: string; productId?: string; newItems?: SaleItem[]; actor: string; role: Role; othersForExtend?: Sale[] }

/** Returns the updated sale and the history line. Never changes the input. */
export function applyAction(sale: Sale, action: SaleActionName, inp: ActionInput, now: Date): { sale: Sale; event: Omit<SaleEvent, 'id' | 'saleId'> } {
  if (!CAN[inp.role][action]) throw new SaleError('FORBIDDEN', 'You cannot do this.');
  const shown = effectiveStatus(sale, now);
  const from = (action === 'END_NOW' || action === 'EXTEND' || action === 'REMOVE_ITEM' || action === 'ADD_ITEMS') ? shown : sale.status;
  if (!FROM[action].includes(from)) throw new SaleError('BAD_TRANSITION', `Cannot ${action.toLowerCase().replace('_', ' ')} a sale that is ${from.toLowerCase()}.`);
  const at = now.toISOString(); const ev = (text: string) => ({ at, actor: inp.actor, text });
  const next: Sale = { ...sale, items: sale.items.map(i => ({ ...i })), revision: sale.revision + 1 };
  const bad = inp.issues.filter(i => i.level === 'BAD');

  switch (action) {
    case 'SAVE_DRAFT': return { sale: next, event: ev('Draft saved') };
    case 'DELETE_DRAFT': return { sale: next, event: ev('Draft deleted') };
    case 'SUBMIT':
    case 'PUBLISH': {
      if (bad.length) throw new SaleError('CHECKS_FAILED', 'Fix the problems first.', bad);
      if (action === 'PUBLISH' && inp.role !== 'OWNER') throw new SaleError('FORBIDDEN', 'Only the owner publishes.');
      if (action === 'SUBMIT' && next.items.some(i => itemPct(next, i) > inp.ownerOnlyAbove)) throw new SaleError('OWNER_ONLY_DISCOUNT', `A discount above ${inp.ownerOnlyAbove}% needs the owner.`);
      if (action === 'SUBMIT') { next.status = 'PENDING'; return { sale: next, event: ev('Sent for approval') }; }
      const goLive = next.kind === 'CLEARANCE' || (next.startsAt !== null && new Date(next.startsAt) <= now);
      if (next.kind === 'CLEARANCE' && !next.startsAt) next.startsAt = at;
      next.status = goLive ? 'LIVE' : 'SCHEDULED';
      return { sale: next, event: ev((sale.status === 'PENDING' ? 'Approved and ' : '') + (goLive ? 'published' : 'scheduled')) };
    }
    case 'SEND_BACK': {
      if (!inp.note || inp.note.trim().length < 5) throw new SaleError('BAD_INPUT', 'Write a short note so the merchandiser knows what to fix.');
      next.status = 'DRAFT'; return { sale: next, event: ev('Sent back: ' + inp.note.trim()) };
    }
    case 'END_NOW': next.endedAt = at; next.status = 'ENDED'; return { sale: next, event: ev('Ended early') };
    case 'EXTEND': {
      if (!inp.newEndsAt || !sale.endsAt || new Date(inp.newEndsAt) <= new Date(sale.endsAt)) throw new SaleError('BAD_INPUT', 'Pick a time later than the current end.');
      next.endsAt = inp.newEndsAt;
      const c = findConflicts(next, inp.othersForExtend ?? [], now);
      if (c.length) throw new SaleError('CHECKS_FAILED', `${c.length} item(s) are in another sale in that period.`);
      return { sale: next, event: ev('End moved to ' + inp.newEndsAt) };
    }
    case 'ADD_ITEMS': {
      const add = inp.newItems ?? [];
      if (!add.length) throw new SaleError('BAD_INPUT', 'Choose at least one product to add.');
      if (add.some((n, i) => next.items.some(x => x.productId === n.productId) || add.findIndex(m => m.productId === n.productId) !== i)) throw new SaleError('BAD_INPUT', 'A product is already in this sale.');
      if (bad.length) throw new SaleError('CHECKS_FAILED', 'Fix the problems first.', bad);
      next.items.push(...add.map(i => ({ ...i })));
      return { sale: next, event: ev(`Added ${add.length} product${add.length === 1 ? '' : 's'} to the sale`) };
    }
    case 'REMOVE_ITEM': {
      if (next.items.length <= 1) throw new SaleError('LAST_ITEM', 'A sale needs at least one item. End the sale instead.');
      next.items = next.items.filter(i => i.productId !== inp.productId); next.pins = next.pins.filter(p => p !== inp.productId);
      return { sale: next, event: ev(`Removed ${inp.productId} from the sale. Price back to normal.`) };
    }
  }
}

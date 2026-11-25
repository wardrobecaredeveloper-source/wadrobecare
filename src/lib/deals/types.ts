/** Sales and campaigns (Mockups 64, 65). Money = whole naira. Times = ISO strings with offset, shown in Lagos time. */
export type Money = number;
export type SaleKind = 'CAMPAIGN' | 'CLEARANCE';
/** What is stored. LIVE and ENDED are labels for display; the truth is always derived with effectiveStatus(sale, now). */
export type SaleStatus = 'DRAFT' | 'PENDING' | 'SCHEDULED' | 'LIVE' | 'ENDED';
export type Role = 'OWNER' | 'MERCHANDISER' | 'FRONTDESK';
export type ReasonType = 'INFO' | 'FLAW' | 'FINAL';

export interface Reason { id: string; label: string; type: ReasonType; active: boolean }
export interface SaleItem { productId: string; pct: number | null; reasonId: string | null; note: string; flawPhotoUrl: string | null }
export interface Sale {
  id: string; name: string; kind: SaleKind; status: SaleStatus;
  startsAt: string | null; endsAt: string | null;          // clearance has no end
  endedAt: string | null;                                   // set by "End now"
  pct: number;                                              // default for items without their own %
  items: SaleItem[];
  home: boolean; pins: string[]; allowFlawOnHome: boolean; countdown: boolean;
  bundleSavingOnSale: boolean;                              // false: sale items are left out of the bundle saving
  blockPromoCodes: boolean;
  headline: string; strip: string; announcement: string;
  createdBy: string; revision: number;
}
export interface SaleEvent { id: string; saleId: string; at: string; actor: string; text: string }

export interface PriceRange { fromSize: string; toSize: string; price: Money }
export interface SaleProduct {
  id: string; name: string; category: string;
  sizes: string[];                 // display order, same order as the price ranges
  priceLow: Money; priceHigh: Money; ranges: PriceRange[];
  stock: number; weightG: number | null;
}
export interface DealSettings {
  roundTo: number;            // 50
  minPercent: number;         // 5
  maxPercent: number;         // 70
  ownerOnlyAbove: number;     // 50
  homeMinItems: number;       // 3
  homeMaxCards: number;       // 4
  countdownHours: number;     // 72
  urgentHours: number;        // 24
}
export const DEFAULT_SETTINGS: DealSettings = { roundTo: 50, minPercent: 5, maxPercent: 70, ownerOnlyAbove: 50, homeMinItems: 3, homeMaxCards: 4, countdownHours: 72, urgentHours: 24 };

export type IssueLevel = 'BAD' | 'WARN';
export type IssueCode =
  | 'NAME_MISSING' | 'DATES_MISSING' | 'END_BEFORE_START' | 'END_IN_PAST' | 'HEADLINE_MISSING' | 'NO_ITEMS' | 'CONFLICT'
  | 'NO_WEIGHT' | 'NO_REDUCTION' | 'PERCENT_RANGE' | 'PERCENT_HIGH' | 'NO_REASON' | 'REASON_OFF' | 'FLAW_NOTE' | 'FLAW_PHOTO' | 'SOLD_OUT' | 'HOME_FEW';
export interface Issue { level: IssueLevel; step: 1 | 2 | 3 | 4; code: IssueCode; message: string; productId?: string }

export type SaleActionName = 'SAVE_DRAFT' | 'SUBMIT' | 'PUBLISH' | 'SEND_BACK' | 'END_NOW' | 'EXTEND' | 'REMOVE_ITEM' | 'ADD_ITEMS' | 'DELETE_DRAFT';
export type SaleErrorCode = 'FORBIDDEN' | 'BAD_TRANSITION' | 'CHECKS_FAILED' | 'OWNER_ONLY_DISCOUNT' | 'BAD_INPUT' | 'LAST_ITEM';
export class SaleError extends Error { constructor(public code: SaleErrorCode, message: string, public issues: Issue[] = []) { super(message); } }

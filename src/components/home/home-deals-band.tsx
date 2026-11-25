import { HomeDeals } from '@/lib/deals/home';
import { DEFAULT_SETTINGS } from '@/lib/deals/types';
import { Countdown } from './countdown';
const n = (x: number) => '₦' + x.toLocaleString('en-US');

/** Server component. Renders nothing when the band is hidden (no sale, or fewer than 3 items to show). */
export function HomeDealsBand({ deals, serverNow, hrefFor }: { deals: HomeDeals; serverNow: string; hrefFor: (productId: string) => string }) {
  if (!deals.show) return null;
  return (
    <div className="dl" aria-labelledby="dl-h">
      <div className="dl-head"><div>
        <span className="eyebrow">{deals.kind === 'CLEARANCE' ? 'Sale & Clearance' : 'Sale'}</span><h2 id="dl-h">{deals.headline}</h2>
        {deals.showCountdown && deals.endsAt && <Countdown endsAt={deals.endsAt} serverNow={serverNow} settings={DEFAULT_SETTINGS} />}
      </div><p>{deals.strip}</p></div>
      <ul className="dl-row">{deals.cards.map(c => (
        <li key={c.productId}><a className="dl-card" href={hrefFor(c.productId)}>
          <span className="dl-badge">SALE</span><span className="dl-pct">-{c.percent}%</span>{c.low !== null && <span className="dl-low">Only {c.low} left</span>}
          <span className={'dl-why' + (c.flaw ? ' flaw' : '')}>{c.reasonLabel}</span><span className="dl-name">{c.name}</span>
          <span className="dl-price">{c.fromPrice && <small>From </small>}{n(c.now)} <s>{n(c.was)}</s></span>
        </a></li>))}</ul>
      <div className="dl-foot"><a className="btn" href="/sale">Shop all sale ({deals.totalItems} items) →</a></div>
    </div>
  );
}

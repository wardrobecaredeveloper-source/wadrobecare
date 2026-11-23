'use client';
import { useEffect, useState } from 'react';
import { countdownView } from '@/lib/deals/home';
import { DealSettings } from '@/lib/deals/types';

/** Ticks once a second only when the clock is showing. Uses the server time offset so a wrong phone clock does not matter. */
export function Countdown({ endsAt, serverNow, settings }: { endsAt: string; serverNow: string; settings: Pick<DealSettings, 'countdownHours' | 'urgentHours'> }) {
  const [offset] = useState(() => new Date(serverNow).getTime() - Date.now());
  const [now, setNow] = useState(() => new Date(Date.now() + offset));
  useEffect(() => { const t = setInterval(() => setNow(new Date(Date.now() + offset)), 1000); return () => clearInterval(t); }, [offset]);
  const v = countdownView(endsAt, now, settings);
  if (v.mode === 'NONE') return null;
  return <span className={'wc-end' + (v.mode === 'URGENT' ? ' wc-soon' : '')} role="timer" aria-live="off">{v.mode === 'DATE' ? 'Ends ' + v.text : 'Ends in ' + v.text}</span>;
}

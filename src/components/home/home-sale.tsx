/**
 * Homepage promotional sales section — uses the developer package's
 * pickHomeDeals() logic and HomeDealsBand component.
 *
 * Fetches active sales from the DB, maps them to the developer's types,
 * calls pickHomeDeals(), and renders via HomeDealsBand.
 */

import { pickHomeDeals, type HomeDeals } from '@/lib/deals/home'
import { DEFAULT_SETTINGS, type Sale, type SaleProduct, type Reason, type SaleItem } from '@/lib/deals/types'
import { HomeDealsBand } from '@/components/home/home-deals-band'
import { db } from '@/lib/db'
import { PRODUCT_SELECT_BASE, CATEGORY_SELECT_BASE } from '@/lib/queries'

export async function HomeSaleSection() {
  const now = new Date()

  // Fetch active and scheduled sales from DB
  const salesRows = await db.sale.findMany({
    where: {
      status: { in: ['LIVE', 'SCHEDULED'] },
    },
    include: {
      items: true,
    },
  }).catch(() => [])

  if (!salesRows || salesRows.length === 0) return null

  // Map DB sales to developer types
  const sales: Sale[] = salesRows.map((s): Sale => ({
    id: s.id,
    name: s.name,
    kind: s.kind === 'CAMPAIGN' ? 'CAMPAIGN' : 'CLEARANCE',
    status: s.status as Sale['status'],
    startsAt: s.startsAt?.toISOString() ?? null,
    endsAt: s.endsAt?.toISOString() ?? null,
    endedAt: s.endedAt?.toISOString() ?? null,
    pct: s.defaultPct,
    items: s.items.map((it): SaleItem => ({
      productId: it.productId,
      pct: it.pct,
      reasonId: it.reasonId,
      note: it.note ?? '',
      flawPhotoUrl: it.flawPhotoUrl,
    })),
    home: s.home,
    pins: s.pins ? JSON.parse(s.pins) : [],
    allowFlawOnHome: s.allowFlawOnHome,
    countdown: s.countdown,
    bundleSavingOnSale: s.bundleSavingOnSale,
    blockPromoCodes: s.blockPromoCodes,
    headline: s.headline ?? '',
    strip: s.subheadline ?? '',
    announcement: s.announcement ?? '',
    createdBy: s.createdById ?? '',
    revision: s.revision,
  }))

  // Fetch all products in the sales
  const productIds = new Set<string>()
  for (const s of sales) for (const it of s.items) productIds.add(it.productId)
  if (productIds.size === 0) return null

  const productsRows = await db.product.findMany({
    where: { id: { in: [...productIds] } },
    select: {
      ...PRODUCT_SELECT_BASE,
      images: { select: { url: true, altText: true }, orderBy: { position: 'asc' }, take: 1 },
      category: { select: { ...CATEGORY_SELECT_BASE } },
      variants: { select: { size: true, stock: true, price: true } },
      weightKg: true,
    },
  }).catch(() => [])

  if (!productsRows || productsRows.length === 0) return null

  // Map DB products to developer's SaleProduct type
  const products: SaleProduct[] = productsRows.map((p) => {
    const priceLow = p.variants.length > 0 ? Math.min(...p.variants.map((v) => v.price ?? p.price)) : p.price
    const priceHigh = p.variants.length > 0 ? Math.max(...p.variants.map((v) => v.price ?? p.price)) : p.price
    const totalStock = p.variants.reduce((s, v) => s + v.stock, 0)
    return {
      id: p.id,
      name: p.name,
      category: p.category?.name ?? '',
      sizes: p.variants.map((v) => v.size ?? 'One Size'),
      priceLow,
      priceHigh,
      ranges: p.variants.length > 0
        ? p.variants.map((v) => ({ fromSize: v.size ?? 'One Size', toSize: v.size ?? 'One Size', price: v.price ?? p.price }))
        : [{ fromSize: 'One Size', toSize: 'One Size', price: p.price }],
      stock: totalStock,
      weightG: p.weightKg ? p.weightKg * 1000 : null,
    }
  })

  // Fetch deal reasons
  const reasonsRows = await db.dealReason.findMany({ where: { active: true } }).catch(() => [])
  const reasons: Reason[] = (reasonsRows ?? []).map((r): Reason => ({
    id: r.id,
    label: r.label,
    type: r.type === 'INFO' ? 'INFO' : r.type === 'MINOR_FLAW' ? 'FLAW' : 'FINAL',
    active: r.active,
  }))

  // Use developer's pickHomeDeals
  const deals = pickHomeDeals(sales, products, reasons, now, DEFAULT_SETTINGS)

  if (!deals.show) return null

  return (
    <HomeDealsBand
      deals={deals}
      serverNow={now.toISOString()}
      hrefFor={(productId: string) => `/product/${products.find((p) => p.id === productId)?.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') ?? productId}`}
    />
  )
}

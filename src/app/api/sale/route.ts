/**
 * Public sale data API — used by the shop page to show sale products.
 *
 * GET /api/sale → returns all active sale/clearance products with campaign prices.
 * No authentication required — this is public product data.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { batchCurrentPrices } from '@/lib/pricing'
import { PRODUCT_SELECT_BASE, CATEGORY_SELECT_BASE } from '@/lib/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const now = new Date()

  const sales = await db.sale.findMany({
    where: {
      status: { in: ['LIVE', 'SCHEDULED'] },
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gte: now } }],
    },
    include: { items: { select: { productId: true, pct: true, reason: true } } },
  })

  const productIds = new Set<string>()
  for (const sale of sales) {
    for (const item of sale.items) productIds.add(item.productId)
  }

  if (productIds.size === 0) return NextResponse.json({ products: [], sales: [] })

  const products = await db.product.findMany({
    where: { id: { in: [...productIds] }, published: true, status: 'ACTIVE' },
    select: {
      ...PRODUCT_SELECT_BASE,
      images: { select: { url: true, altText: true }, orderBy: { position: 'asc' }, take: 1 },
      category: { select: { ...CATEGORY_SELECT_BASE } },
    },
  })

  const priceMap = await batchCurrentPrices(products.map((p) => ({ id: p.id, price: p.price, salePrice: p.salePrice })))

  const saleProducts = products
    .map((p) => {
      const price = priceMap.get(p.id)
      if (!price?.isCampaignPrice) return null
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        price: price.price,
        originalPrice: p.price,
        discountPct: price.discountPct,
        dealReason: price.dealReason,
        image: p.images[0]?.url ?? null,
        category: p.category?.name ?? null,
        categorySlug: p.category?.slug ?? null,
      }
    })
    .filter(Boolean)

  return NextResponse.json({
    products: saleProducts,
    sales: sales.map((s) => ({
      id: s.id,
      name: s.name,
      headline: s.headline,
      subheadline: s.subheadline,
      endsAt: s.endsAt,
    })),
  })
}

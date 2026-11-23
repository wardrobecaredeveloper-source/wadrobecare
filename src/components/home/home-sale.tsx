/**
 * Homepage promotional sales section.
 *
 * Displays campaign products with sale prices on the homepage,
 * between "Shop by World" and "New Arrivals".
 *
 * Shows a maximum of 4 products from the active homepage campaign.
 * Includes countdown if < 72 hours remaining.
 */

import Link from 'next/link'
import Image from 'next/image'
import { getHomepageSale, batchCurrentPrices } from '@/lib/pricing'
import { db } from '@/lib/db'
import { PRODUCT_SELECT_BASE } from '@/lib/queries'
import { formatNGN } from '@/lib/format'

export async function HomeSaleSection() {
  const sale = await getHomepageSale()
  if (!sale) return null

  // Get product IDs from the sale
  const productIds = [...sale.items.keys()]
  if (productIds.length < 3) return null // need at least 3 for the band

  // Fetch products
  const products = await db.product.findMany({
    where: {
      id: { in: productIds },
      published: true,
      status: 'ACTIVE',
      outOfStock: false,
    },
    select: {
      ...PRODUCT_SELECT_BASE,
      images: { select: { url: true, altText: true }, orderBy: { position: 'asc' }, take: 1 },
      category: { select: { name: true, slug: true } },
    },
    take: 20, // fetch more, filter down
  })

  if (products.length < 3) return null

  // Calculate prices
  const priceMap = await batchCurrentPrices(products.map((p) => ({ id: p.id, price: p.price, salePrice: p.salePrice })))

  // Filter to products with active campaign prices
  const saleProducts = products.filter((p) => {
    const price = priceMap.get(p.id)
    return price && price.isCampaignPrice && price.discountPct > 0
  })

  if (saleProducts.length < 3) return null

  // Sort: pinned first, then highest discount, then by product ID
  const pins = sale.pins ? JSON.parse(sale.pins) : []
  saleProducts.sort((a, b) => {
    const aPinned = pins.includes(a.id) ? 0 : 1
    const bPinned = pins.includes(b.id) ? 0 : 1
    if (aPinned !== bPinned) return aPinned - bPinned
    const aPct = priceMap.get(a.id)?.discountPct ?? 0
    const bPct = priceMap.get(b.id)?.discountPct ?? 0
    if (aPct !== bPct) return bPct - aPct
    return a.id.localeCompare(b.id)
  })

  // Show max 4 products
  const displayProducts = saleProducts.slice(0, 4)

  // Countdown
  const now = new Date()
  const endsAt = sale.endsAt
  const hoursLeft = endsAt ? Math.floor((endsAt.getTime() - now.getTime()) / (1000 * 60 * 60)) : null
  const showCountdown = sale.countdown && hoursLeft !== null && hoursLeft < 72
  const urgent = hoursLeft !== null && hoursLeft < 24

  function formatCountdown(ms: number): string {
    const h = Math.floor(ms / (1000 * 60 * 60))
    const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60))
    const s = Math.floor((ms % (1000 * 60)) / 1000)
    return `${h}h ${m}m ${s}s`
  }

  return (
    <section className="py-16 md:py-24 bg-secondary/30">
      <div className="max-w-7xl mx-auto px-4 md:px-8">
        {/* Header */}
        <div className="text-center mb-10">
          {sale.headline && (
            <h2 className="font-display text-3xl md:text-4xl text-foreground mb-3">
              {sale.headline}
            </h2>
          )}
          {sale.subheadline && (
            <p className="text-sm md:text-base text-muted-foreground max-w-2xl mx-auto">
              {sale.subheadline}
            </p>
          )}
          {showCountdown && endsAt && (
            <div className={`mt-4 inline-flex items-center gap-2 text-sm font-mono ${urgent ? 'text-red-600' : 'text-foreground'}`}>
              {urgent ? 'Ends in:' : 'Sale ends in:'}{' '}
              <span id="sale-countdown" data-ends-at={endsAt.toISOString()}>
                {formatCountdown(endsAt.getTime() - now.getTime())}
              </span>
            </div>
          )}
        </div>

        {/* Product grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
          {displayProducts.map((product) => {
            const price = priceMap.get(product.id)!
            const image = product.images[0]
            return (
              <Link key={product.id} href={`/product/${product.slug}`} className="group">
                <div className="relative aspect-square overflow-hidden bg-muted rounded-md mb-3">
                  {image ? (
                    <Image
                      src={image.url}
                      alt={image.altText ?? product.name}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-500"
                      sizes="(max-width: 768px) 50vw, 25vw"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                      No image
                    </div>
                  )}
                  {/* SALE badge */}
                  <div className="absolute top-2 left-2 bg-red-600 text-white text-[10px] uppercase tracking-wider px-2 py-1 rounded">
                    -{price.discountPct}%
                  </div>
                  {/* Deal reason badge */}
                  {price.dealReason && (
                    <div className="absolute top-2 right-2 bg-foreground/90 text-background text-[9px] uppercase px-2 py-0.5 rounded">
                      {price.dealReason}
                    </div>
                  )}
                </div>
                <h3 className="text-sm font-medium line-clamp-2 group-hover:text-foreground/80 transition-colors">
                  {product.name}
                </h3>
                {product.category && (
                  <p className="text-xs text-muted-foreground mt-0.5">{product.category.name}</p>
                )}
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-sm font-semibold text-red-600">
                    {formatNGN(price.price)}
                  </span>
                  <span className="text-xs text-muted-foreground line-through">
                    {formatNGN(price.originalPrice ?? product.price)}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>

        {/* Shop all sale button */}
        <div className="mt-8 text-center">
          <Link
            href="/shop?sort=sale"
            className="inline-flex items-center gap-2 border border-foreground/25 px-6 py-3 text-xs uppercase tracking-[0.18em] hover:bg-foreground hover:text-background transition-colors"
          >
            Shop All Sale
          </Link>
        </div>
      </div>
    </section>
  )
}

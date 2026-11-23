/**
 * Server-side helper to annotate product lists with campaign prices.
 *
 * Used by product listing pages (shop, category hubs, featured products,
 * new arrivals, related products) so they all show the same campaign price.
 */

import { batchCurrentPrices, type PriceResult } from '@/lib/pricing'

/**
 * Takes a list of products (with at least id, price, salePrice) and returns
 * a Map of productId → PriceResult for display.
 *
 * The caller should use this to override the `price` and `salePrice` fields
 * when rendering product cards.
 */
export async function annotatePrices<T extends { id: string; price: number; salePrice?: number | null }>(
  products: T[],
): Promise<Map<string, PriceResult>> {
  if (products.length === 0) return new Map()
  return batchCurrentPrices(products.map((p) => ({ id: p.id, price: p.price, salePrice: p.salePrice })))
}

/**
 * Apply campaign prices to a product object for client consumption.
 *
 * Returns a new object with `displayPrice` and `displayOriginalPrice` fields
 * added, representing the price the customer should see.
 */
export function applyPrice<T extends { id: string; price: number; salePrice?: number | null }>(
  product: T,
  priceMap: Map<string, PriceResult>,
): T & {
  displayPrice: number
  displayOriginalPrice: number | null
  isCampaignPrice: boolean
  discountPct: number
  dealReason?: string
} {
  const p = priceMap.get(product.id)
  if (p?.isCampaignPrice) {
    return {
      ...product,
      displayPrice: p.price,
      displayOriginalPrice: product.price,
      isCampaignPrice: true,
      discountPct: p.discountPct,
      dealReason: p.dealReason,
    }
  }

  // Manual salePrice or normal price
  const manualSale = product.salePrice && product.salePrice > 0 && product.salePrice < product.price
  return {
    ...product,
    displayPrice: manualSale ? product.salePrice! : product.price,
    displayOriginalPrice: manualSale ? product.price : null,
    isCampaignPrice: false,
    discountPct: manualSale
      ? Math.round((1 - (product.salePrice! / product.price)) * 100)
      : 0,
  }
}

/**
 * Apply campaign prices to an array of products.
 */
export function applyPrices<T extends { id: string; price: number; salePrice?: number | null }>(
  products: T[],
  priceMap: Map<string, PriceResult>,
): Array<T & {
  displayPrice: number
  displayOriginalPrice: number | null
  isCampaignPrice: boolean
  discountPct: number
  dealReason?: string
}> {
  return products.map((p) => applyPrice(p, priceMap))
}

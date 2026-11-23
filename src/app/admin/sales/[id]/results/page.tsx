import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/session'
import { getMyPermissionCodes } from '@/lib/permissions'
import { db } from '@/lib/db'
import { AdminLayout } from '@/components/admin/admin-layout'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatNGN } from '@/lib/format'
import { PRODUCT_SELECT_BASE } from '@/lib/queries'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Campaign Results',
  robots: { index: false, follow: false },
}

type Params = Promise<{ id: string }>

export default async function SaleResultsPage({ params }: { params: Params }) {
  await requireAdmin()
  const perms = await getMyPermissionCodes()
  const { id } = await params

  const sale = await db.sale.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: {
            select: {
              ...PRODUCT_SELECT_BASE,
              images: { select: { url: true, altText: true }, orderBy: { position: 'asc' }, take: 1 },
              variants: { select: { stock: true, size: true } },
            },
          },
        },
      },
      events: {
        include: { actor: { select: { name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      },
    },
  })

  if (!sale) notFound()

  // Query order items that reference this sale's products to calculate performance.
  // We match by product slug (since OrderItem stores a snapshot, not a FK to Sale).
  // For a more robust approach, we'd add a saleId to OrderItem — but for now
  // we use the order items created during the sale's active period.
  const saleStart = sale.startsAt
  const saleEnd = sale.endedAt ?? sale.endsAt ?? new Date()

  const orderItems = await db.orderItem.findMany({
    where: {
      createdAt: { gte: saleStart, lte: saleEnd },
      productId: { in: sale.items.map((i) => i.productId) },
    },
    select: {
      productId: true,
      productName: true,
      unitPrice: true,
      quantity: true,
      totalPrice: true,
      createdAt: true,
    },
  })

  // Aggregate per product
  const productPerf = new Map<string, { unitsSold: number; revenue: number }>()
  for (const oi of orderItems) {
    const existing = productPerf.get(oi.productId) ?? { unitsSold: 0, revenue: 0 }
    existing.unitsSold += oi.quantity
    existing.revenue += oi.totalPrice
    productPerf.set(oi.productId, existing)
  }

  const totalUnitsSold = orderItems.reduce((s, oi) => s + oi.quantity, 0)
  const totalRevenue = orderItems.reduce((s, oi) => s + oi.totalPrice, 0)

  // Identify low stock and sold-out products
  const lowStock = sale.items.filter((i) => {
    const totalStock = i.product.variants.reduce((s, v) => s + v.stock, 0)
    return totalStock > 0 && totalStock <= 5
  })
  const soldOut = sale.items.filter((i) => {
    const totalStock = i.product.variants.reduce((s, v) => s + v.stock, 0)
    return totalStock === 0
  })

  return (
    <AdminLayout
      title={`${sale.name} — Results`}
      description={`${sale.status} · ${sale.items.length} products`}
      permissions={perms}
    >
      <div className="p-6 space-y-6">
        {/* KPI cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Units Sold</p>
              <p className="font-display text-2xl mt-1">{totalUnitsSold}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Revenue</p>
              <p className="font-display text-2xl mt-1 text-green-700">{formatNGN(totalRevenue)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Low Stock</p>
              <p className="font-display text-2xl mt-1 text-amber-600">{lowStock.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Sold Out</p>
              <p className="font-display text-2xl mt-1 text-red-600">{soldOut.length}</p>
            </CardContent>
          </Card>
        </div>

        {/* Per-product performance table */}
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-muted-foreground border-b">
                  <tr>
                    <th className="text-left p-3">Product</th>
                    <th className="text-right p-3">Original Price</th>
                    <th className="text-right p-3">Campaign Price</th>
                    <th className="text-right p-3">Discount</th>
                    <th className="text-right p-3">Units Sold</th>
                    <th className="text-right p-3">Stock Left</th>
                    <th className="text-right p-3">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {sale.items.map((item) => {
                    const perf = productPerf.get(item.productId) ?? { unitsSold: 0, revenue: 0 }
                    const totalStock = item.product.variants.reduce((s, v) => s + v.stock, 0)
                    const pct = item.pct ?? sale.defaultPct
                    const campaignPrice = Math.round((item.product.price * (1 - pct / 100)) / 50) * 50
                    return (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            {item.product.images[0] ? (
                              <img src={item.product.images[0].url} alt={item.product.name} className="h-8 w-8 rounded object-cover" />
                            ) : <div className="h-8 w-8 rounded bg-muted" />}
                            <span className="font-medium">{item.product.name}</span>
                          </div>
                        </td>
                        <td className="p-3 text-right tabular-nums text-muted-foreground line-through">
                          {formatNGN(item.product.price)}
                        </td>
                        <td className="p-3 text-right tabular-nums font-medium text-red-600">
                          {formatNGN(campaignPrice)}
                        </td>
                        <td className="p-3 text-right">
                          <Badge variant="outline">{pct}%</Badge>
                        </td>
                        <td className="p-3 text-right tabular-nums">{perf.unitsSold}</td>
                        <td className="p-3 text-right tabular-nums">
                          {totalStock === 0 ? (
                            <Badge variant="destructive">Sold out</Badge>
                          ) : totalStock <= 5 ? (
                            <Badge className="bg-amber-100 text-amber-800">{totalStock} left</Badge>
                          ) : (
                            <span>{totalStock}</span>
                          )}
                        </td>
                        <td className="p-3 text-right tabular-nums font-medium">
                          {formatNGN(perf.revenue)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Activity log */}
        <div>
          <h3 className="font-display text-lg mb-3">Activity Log</h3>
          <div className="space-y-2 max-w-2xl">
            {sale.events.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No activity yet.</p>
            ) : (
              sale.events.map((e) => (
                <div key={e.id} className="flex gap-3 border-b last:border-0 py-2">
                  <div className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(e.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                  </div>
                  <div className="text-sm flex-1">
                    {e.text}
                    {e.actor && <span className="text-xs text-muted-foreground"> — {e.actor.name || e.actor.email}</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  )
}

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Temporary diagnostic endpoint that wraps the /shop page's query logic
 * and captures any exception. Returns the actual error name + message +
 * stack trace as JSON instead of the opaque 'error code: 1101'.
 *
 * Will be removed after diagnosis.
 */
export async function GET() {
  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    runtime: {
      userAgent:
        (globalThis as { navigator?: { userAgent?: string } }).navigator
          ?.userAgent ?? "unknown",
      hasDatabaseUrl: !!process.env.DATABASE_URL,
    },
    steps: {} as Record<string, unknown>,
  };

  // Step 1: import the queries (just imports, no execution)
  try {
    const queries = await import("@/lib/queries");
    result.steps.import_queries = {
      ok: true,
      exportedFunctions: Object.keys(queries).slice(0, 10),
    };
  } catch (e: any) {
    result.steps.import_queries = {
      ok: false,
      error: { name: e?.name, message: e?.message?.slice(0, 300) },
    };
    return NextResponse.json(result, { status: 200 });
  }

  // Step 2: call getProducts (the heavy query that /shop uses)
  try {
    const { getProducts } = await import("@/lib/queries");
    const start = Date.now();
    const products = await getProducts({
      limit: 100, // matches /shop's actual usage
    });
    const elapsed = Date.now() - start;
    result.steps.getProducts = {
      ok: true,
      elapsedMs: elapsed,
      productCount: products.length,
      firstProduct: products[0]
        ? {
            id: products[0].id,
            name: products[0].name?.slice(0, 50),
            hasImages: !!(products[0].images && products[0].images.length),
            hasVariants: !!(products[0].variants && products[0].variants.length),
          }
        : null,
    };
  } catch (e: any) {
    result.steps.getProducts = {
      ok: false,
      error: {
        name: e?.name,
        message: e?.message?.slice(0, 500),
        stack: e?.stack?.split("\n").slice(0, 15).join("\n"),
      },
    };
  }

  // Step 3: call getCategories (the second parallel query /shop uses)
  try {
    const { getCategories } = await import("@/lib/queries");
    const start = Date.now();
    const categories = await getCategories();
    const elapsed = Date.now() - start;
    result.steps.getCategories = {
      ok: true,
      elapsedMs: elapsed,
      categoryCount: categories.length,
    };
  } catch (e: any) {
    result.steps.getCategories = {
      ok: false,
      error: {
        name: e?.name,
        message: e?.message?.slice(0, 500),
        stack: e?.stack?.split("\n").slice(0, 15).join("\n"),
      },
    };
  }

  // Step 4: do BOTH in parallel (what /shop actually does)
  try {
    const { getProducts, getCategories } = await import("@/lib/queries");
    const start = Date.now();
    const [products, categories] = await Promise.all([
      getProducts({ limit: 100 }),
      getCategories(),
    ]);
    const elapsed = Date.now() - start;
    result.steps.parallel = {
      ok: true,
      elapsedMs: elapsed,
      productCount: products.length,
      categoryCount: categories.length,
    };
  } catch (e: any) {
    result.steps.parallel = {
      ok: false,
      error: {
        name: e?.name,
        message: e?.message?.slice(0, 500),
        stack: e?.stack?.split("\n").slice(0, 15).join("\n"),
      },
    };
  }

  return NextResponse.json(result, { status: 200 });
}

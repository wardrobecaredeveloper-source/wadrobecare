import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const diagnostics: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
  };

  // Test each homepage query in isolation
  const tests: { name: string; fn: () => Promise<unknown> }[] = [
    { name: "getCategories", fn: async () => {
      const { getCategories } = await import("@/lib/queries");
      return await getCategories();
    }},
    { name: "getNewArrivals(10)", fn: async () => {
      const { getNewArrivals } = await import("@/lib/queries");
      return await getNewArrivals(10);
    }},
    { name: "getFeaturedProducts(4)", fn: async () => {
      const { getFeaturedProducts } = await import("@/lib/queries");
      return await getFeaturedProducts(4);
    }},
    { name: "getHomepageContent", fn: async () => {
      const { getHomepageContent } = await import("@/lib/queries");
      return await getHomepageContent();
    }},
    { name: "getAdminSettings", fn: async () => {
      const { getAdminSettings } = await import("@/lib/queries");
      return await getAdminSettings();
    }},
  ];

  const results: Record<string, unknown> = {};
  for (const test of tests) {
    const start = Date.now();
    try {
      const result = await test.fn();
      const elapsed = Date.now() - start;
      results[test.name] = {
        ok: true,
        elapsedMs: elapsed,
        type: Array.isArray(result) ? `array (${result.length} items)` : typeof result,
      };
    } catch (e: any) {
      const elapsed = Date.now() - start;
      results[test.name] = {
        ok: false,
        elapsedMs: elapsed,
        error: e?.message?.slice(0, 300),
      };
    }
  }

  diagnostics.queries = results;

  // Now try all in parallel
  const startParallel = Date.now();
  try {
    const { getCategories, getNewArrivals, getFeaturedProducts, getHomepageContent, getAdminSettings } = await import("@/lib/queries");
    const [categories, newArrivals, featured, content, settings] = await Promise.all([
      getCategories(),
      getNewArrivals(10),
      getFeaturedProducts(4),
      getHomepageContent(),
      getAdminSettings(),
    ]);
    const elapsed = Date.now() - startParallel;
    diagnostics.parallel = {
      ok: true,
      elapsedMs: elapsed,
      categories: categories.length,
      newArrivals: newArrivals.length,
      featured: featured.length,
      hasContent: !!content,
      hasSettings: !!settings,
    };
  } catch (e: any) {
    const elapsed = Date.now() - startParallel;
    diagnostics.parallel = {
      ok: false,
      elapsedMs: elapsed,
      error: e?.message?.slice(0, 500),
      stack: e?.stack?.split("\n").slice(0, 5).join("\n"),
    };
  }

  return NextResponse.json(diagnostics, { status: 200 });
}

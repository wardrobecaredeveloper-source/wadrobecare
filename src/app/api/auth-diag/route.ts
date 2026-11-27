import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Diagnostic endpoint that captures the ACTUAL exception + stack trace
 * from NextAuth on Cloudflare Workers. Returns JSON instead of the
 * opaque 'error code: 1101'.
 *
 * Runs through three checks:
 *   1. Can we import next-auth?
 *   2. Can we import authOptions?
 *   3. Can we invoke the NextAuth handler with a fake Request?
 *
 * Returns: { check, ok, error: { name, message, stack } }
 */
export async function GET() {
  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    runtime: {
      userAgent:
        (globalThis as { navigator?: { userAgent?: string } }).navigator
          ?.userAgent ?? "unknown",
      hasNextAuthSecret: !!process.env.NEXTAUTH_SECRET,
      hasNextAuthUrl: !!process.env.NEXTAUTH_URL,
      nextAuthUrl: process.env.NEXTAUTH_URL ?? null,
      hasDatabaseUrl: !!process.env.DATABASE_URL,
    },
    checks: {} as Record<string, unknown>,
  };

  // Check 1: import next-auth
  try {
    const na = await import("next-auth");
    result.checks.import_next_auth = {
      ok: true,
      default: typeof na.default,
      hasDefault: !!na.default,
      hasGetServerSession: typeof na.getServerSession,
    };
  } catch (e: any) {
    result.checks.import_next_auth = {
      ok: false,
      error: {
        name: e?.name,
        message: e?.message?.slice(0, 500),
        stack: e?.stack?.split("\n").slice(0, 10).join("\n"),
      },
    };
    return NextResponse.json(result, { status: 200 });
  }

  // Check 2: import authOptions
  try {
    const { authOptions } = await import("@/lib/auth");
    result.checks.import_authOptions = {
      ok: true,
      hasAdapter: !!authOptions.adapter,
      hasSession: !!authOptions.session,
      sessionStrategy: (authOptions.session as any)?.strategy,
      providerCount: authOptions.providers?.length,
      hasSignInPage: !!authOptions.pages?.signIn,
    };
  } catch (e: any) {
    result.checks.import_authOptions = {
      ok: false,
      error: {
        name: e?.name,
        message: e?.message?.slice(0, 500),
        stack: e?.stack?.split("\n").slice(0, 15).join("\n"),
      },
    };
    // Don't return early — continue to check 2b which diagnoses the root cause
  }

  // Check 2b: import next-auth/providers/credentials directly + inspect its shape
  try {
    const credMod = await import("next-auth/providers/credentials");
    result.checks.import_credentials_provider = {
      ok: true,
      typeOfDefault: typeof (credMod as any).default,
      typeOfModule: typeof credMod,
      keys: Object.keys(credMod),
      hasDefault: "default" in (credMod as any),
      defaultIsFunction: typeof (credMod as any).default === "function",
      // Check if default.default exists (would indicate double-wrapping)
      hasDefaultDefault:
        typeof (credMod as any).default === "object" &&
        (credMod as any).default !== null &&
        "default" in (credMod as any).default,
      typeOfDefaultDefault:
        typeof (credMod as any).default === "object" &&
        (credMod as any).default !== null
          ? typeof (credMod as any).default.default
          : "n/a",
    };
  } catch (e: any) {
    result.checks.import_credentials_provider = {
      ok: false,
      error: {
        name: e?.name,
        message: e?.message?.slice(0, 500),
        stack: e?.stack?.split("\n").slice(0, 10).join("\n"),
      },
    };
  }

  // Check 2c: try calling the default export to see if it's actually a function
  try {
    const credMod = await import("next-auth/providers/credentials");
    const defaultExport = (credMod as any).default;
    let isCallable = typeof defaultExport === "function";
    let doubleWrapped = false;
    if (!isCallable && defaultExport && typeof defaultExport === "object") {
      // Check if it's the double-wrapped module pattern (Rolldown bug)
      if (typeof defaultExport.default === "function") {
        isCallable = true;
        doubleWrapped = true;
      }
    }
    result.checks.credentials_provider_call_test = {
      ok: isCallable,
      isCallable,
      doubleWrapped, // true if we need .default.default to get the actual function
      suggestion: doubleWrapped
        ? "Rolldown CJS interop bug — use `(credMod.default as any).default || credMod.default` to unwrap"
        : isCallable
          ? "Works correctly"
          : "Default export is not callable — likely needs full auth migration",
    };
  } catch (e: any) {
    result.checks.credentials_provider_call_test = {
      ok: false,
      error: {
        name: e?.name,
        message: e?.message?.slice(0, 500),
      },
    };
  }

  // Check 3: invoke the NextAuth handler with a fake Request
  // Reproduce what GET /api/auth/providers would do.
  try {
    const NextAuth = (await import("next-auth")).default;
    const { authOptions } = await import("@/lib/auth");
    const handler = NextAuth(authOptions);

    const fakeReq = new Request(
      new URL("/api/auth/providers", process.env.NEXTAUTH_URL || "http://localhost"),
      { method: "GET" },
    );
    const fakeRes = await handler(fakeReq, {} as any);
    result.checks.invoke_handler = {
      ok: true,
      status: fakeRes.status,
      contentType: fakeRes.headers.get("content-type"),
      bodyPreview: (await fakeRes.text().catch(() => "")).slice(0, 200),
    };
  } catch (e: any) {
    result.checks.invoke_handler = {
      ok: false,
      error: {
        name: e?.name,
        message: e?.message?.slice(0, 500),
        stack: e?.stack?.split("\n").slice(0, 20).join("\n"),
      },
    };
  }

  // Check 4: test the Prisma adapter directly
  try {
    const { PrismaAdapter } = await import("@next-auth/prisma-adapter");
    const { db } = await import("@/lib/db");
    const adapter = PrismaAdapter(db as any);
    result.checks.prisma_adapter = {
      ok: true,
      methods: Object.keys(adapter).sort(),
      hasGetUser: typeof adapter.getUser,
    };
  } catch (e: any) {
    result.checks.prisma_adapter = {
      ok: false,
      error: {
        name: e?.name,
        message: e?.message?.slice(0, 500),
        stack: e?.stack?.split("\n").slice(0, 10).join("\n"),
      },
    };
  }

  return NextResponse.json(result, { status: 200 });
}

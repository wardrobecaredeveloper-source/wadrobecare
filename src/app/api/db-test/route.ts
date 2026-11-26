import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const diagnostics: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    runtime: {
      hasProcessEnv: typeof process !== "undefined" && !!process.env,
      hasDatabaseUrl: !!process.env.DATABASE_URL,
      databaseUrlPrefix: process.env.DATABASE_URL
        ? process.env.DATABASE_URL.slice(0, 30) + "..."
        : null,
      hasNextAuthSecret: !!process.env.NEXTAUTH_SECRET,
      hasEmailProvider: !!process.env.EMAIL_PROVIDER,
      emailProviderValue: process.env.EMAIL_PROVIDER ?? null,
    },
  };

  // Runtime detection — same as db.ts
  try {
    const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
    const ua = nav?.userAgent ?? "";
    diagnostics.runtime.navigatorUserAgent = ua;
    diagnostics.runtime.isCloudflareWorkers =
      ua.includes("Cloudflare-Workers") ||
      !process.versions ||
      Object.keys(process.versions || {}).length === 0;
    diagnostics.runtime.processVersionsKeys = Object.keys(
      process.versions || {},
    );
  } catch (e: any) {
    diagnostics.runtime.detectionError = e?.message;
  }

  // Try to import cloudflare:workers — via static import, not new Function
  try {
    const cfMod: any = await import("cloudflare:workers");
    diagnostics.runtime.cloudflareWorkersImport = "success";
    const env = cfMod?.env || {};
    diagnostics.runtime.envKeys = Object.keys(env);
    diagnostics.runtime.hasHyperdrive = !!env.HYPERDRIVE;
    if (env.HYPERDRIVE) {
      diagnostics.runtime.hyperdriveKeys = Object.keys(env.HYPERDRIVE);
      diagnostics.runtime.hyperdriveConnectionString = env.HYPERDRIVE.connectionString
        ? String(env.HYPERDRIVE.connectionString).slice(0, 40) + "..."
        : null;
    }
  } catch (e: any) {
    diagnostics.runtime.cloudflareWorkersImport = "failed";
    diagnostics.runtime.cloudflareWorkersError = e?.message;
  }

  // Now try the actual Prisma client
  try {
    const { db } = await import("@/lib/db");
    diagnostics.prisma = "imported";
    // Try a simple query — count users
    const userCount = await db.user.count();
    diagnostics.userCount = userCount;
    diagnostics.prismaQuery = "success";
  } catch (e: any) {
    diagnostics.prisma = "failed";
    diagnostics.prismaError = {
      name: e?.name,
      message: e?.message?.slice(0, 300),
      stack: e?.stack?.split("\n").slice(0, 5).join("\n"),
    };
  }

  return NextResponse.json(diagnostics, { status: 200 });
}

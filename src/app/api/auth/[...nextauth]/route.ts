import * as NextAuthModule from 'next-auth'
import { authOptions } from '@/lib/auth'

// Workaround for the same Rolldown CJS-to-ESM interop bug that affects
// next-auth/providers/credentials (see src/lib/auth.ts for full notes).
// next-auth's default export is the NextAuth() function. Under Rolldown's
// __esm() helper with the `, 1` flag, the whole module gets wrapped as
// `.default`, so the actual function lives at `.default.default`.
//
// Defensive check handles both the broken and future-fixed interop.
const NextAuth = (
  typeof (NextAuthModule as any).default === 'function'
    ? (NextAuthModule as any).default
    : (NextAuthModule as any).default?.default
) as typeof import('next-auth').default

const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }

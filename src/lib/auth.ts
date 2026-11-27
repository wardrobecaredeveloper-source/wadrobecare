import { NextAuthOptions } from 'next-auth'
import * as CredentialsProviderModule from 'next-auth/providers/credentials'

// Workaround for a Rolldown CJS-to-ESM interop bug on Cloudflare Workers.
// next-auth/providers/credentials is a CJS module with:
//   Object.defineProperty(exports, "__esModule", { value: true })
//   exports.default = Credentials
// Rolldown's __esm() helper, when invoked with the `, 1` flag for this
// module, wraps the WHOLE module as the default export instead of using
// module.default. So the actual Credentials function lives at
// credMod.default.default, not credMod.default. The defensive check
// below handles both the broken and future-fixed interop.
const CredentialsProvider = (
  typeof (CredentialsProviderModule as any).default === 'function'
    ? (CredentialsProviderModule as any).default
    : (CredentialsProviderModule as any).default?.default
) as typeof import('next-auth/providers/credentials').default
import { PrismaAdapter } from '@next-auth/prisma-adapter'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { authSecret } from '@/lib/auth-fallback-secret'

// Stable fallback secret lives in src/lib/auth-fallback-secret.ts so the
// Edge middleware can verify session tokens without importing this module
// (this file pulls in Prisma, which cannot run in the Edge runtime).

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(db),
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/account/login',
  },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null
        const email = credentials.email.toLowerCase()

        // Brute-force throttle: 8 failed-capable attempts per 10 min per email,
        // then a 15-minute lockout. Rate-limit BEFORE any DB work so locked
        // attackers never touch the database.
        const rl = rateLimit(`login:${email}`, {
          limit: 8,
          windowMs: 10 * 60 * 1000,
          blockMs: 15 * 60 * 1000,
        })
        if (!rl.ok) {
          console.warn(
            `[auth] login rate-limited for ${email} — retry in ${rl.retryAfterSec}s`,
          )
          return null
        }

        const user = await db.user.findUnique({
          where: { email },
        })
        if (!user || !user.passwordHash) return null
        // Defensive: inactive accounts cannot sign in.
        if (user.active === false) return null
        const ok = await bcrypt.compare(credentials.password, user.passwordHash)
        if (!ok) return null
        // Stamp lastLoginAt so the dashboard can show the most recent login.
        await db.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        }).catch(() => { /* non-fatal */ })
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        } as any
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as any).id
        token.role = (user as any).role
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        ;(session.user as any).id = token.id
        ;(session.user as any).role = token.role
      }
      return session
    },
  },
  secret: authSecret,
}

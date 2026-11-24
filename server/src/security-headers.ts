// The headers every response carries. The CSP allows what Clerk's docs list for its scripts, frames and API calls
// (https://clerk.com/docs/guides/secure/best-practices/csp-headers) and nothing else outside 'self'.
import type { MiddlewareHandler } from "hono";

function contentSecurityPolicy(frontendApiHost: string): string {
  const clerk = `https://${frontendApiHost}`;
  return [
    "default-src 'self'",
    `script-src 'self' ${clerk} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    // The protection hosts use ports other than 443, and a source with no port matches 443 only.
    `connect-src 'self' ${clerk} https://*.protect.clerk.com:*`,
    "img-src 'self' https://img.clerk.com",
    "worker-src 'self' blob:",
    // Clerk generates its CSS at run time.
    "style-src 'self' 'unsafe-inline'",
    "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function securityHeaders(frontendApiHost: string): MiddlewareHandler {
  const csp = contentSecurityPolicy(frontendApiHost);
  return async (c, next) => {
    await next();
    c.res.headers.set("Content-Security-Policy", csp);
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  };
}

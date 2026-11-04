import dns from 'node:dns/promises';
import net from 'node:net';

export interface SecurityHeadersOptions {
  isHttps: boolean;
  isDev: boolean;
}

export function buildContentSecurityPolicy(isDev: boolean): string {
  const bexoraAuthRelayOrigins = [
    'https://bexora.ai.studio',
    'https://bexora-448578956301.asia-southeast1.run.app',
    'https://auth.bexora.com',
    'https://bexora.com',
    'https://www.bexora.com',
  ];
  const connectSources = [
    "'self'",
    ...bexoraAuthRelayOrigins,
    'https://*.googleapis.com',
    'https://*.firebaseio.com',
    'https://*.firebaseapp.com',
    'wss://*.firebaseio.com',
    'https://apis.google.com',
    'https://accounts.google.com',
    'https://www.gstatic.com',
  ];
  if (isDev) {
    connectSources.push('ws:', 'wss:');
  }

  const frameSources = [
    "'self'",
    ...bexoraAuthRelayOrigins,
    'https://*.firebaseapp.com',
    'https://accounts.google.com',
    'https://apis.google.com',
    'https://www.google.com',
    'https://recaptcha.google.com',
  ];

  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://apis.google.com https://accounts.google.com https://www.gstatic.com https://www.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    `connect-src ${connectSources.join(' ')}`,
    `frame-src ${frameSources.join(' ')}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self' https://*.google.com https://aistudio.google.com https://*.googleusercontent.com",
  ].join('; ');
}

export function buildSecurityHeaders(options: SecurityHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)',
    'Content-Security-Policy': buildContentSecurityPolicy(options.isDev),
  };

  if (options.isHttps) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  return headers;
}

export interface CorsCsrfInput {
  method: string;
  path: string;
  originHeader?: string;
  refererHeader?: string;
  hostHeader?: string;
  forwardedHostHeader?: string;
  secFetchSiteHeader?: string;
  allowedOrigins?: string[];
}

export interface CorsCsrfDecision {
  allowed: boolean;
  statusCode?: number;
  errorCode?: string;
  corsOriginToReflect?: string;
}

const CSRF_EXEMPT_PATHS = new Set<string>([
  '/api/payments/wordpress/webhook', // Uses cryptographic HMAC-SHA256 + timestamp + replay nonce verification
]);

function normalizeHostValue(raw: string | undefined): string {
  if (!raw) return '';
  return raw.split(',')[0]!.trim().toLowerCase();
}

export function evaluateApiCorsAndCsrf(input: CorsCsrfInput): CorsCsrfDecision {
  const method = String(input.method || 'GET').toUpperCase();
  const path = String(input.path || '');
  const originRaw = String(input.originHeader || '').trim();
  const refererRaw = String(input.refererHeader || '').trim();
  const primaryHost = normalizeHostValue(input.hostHeader);
  const allowlist = new Set(
    (input.allowedOrigins || [])
      .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
      .filter(Boolean)
  );
  const allowlistHosts = new Set<string>();
  for (const item of allowlist) {
    try {
      allowlistHosts.add(new URL(item).host.toLowerCase());
    } catch {
      // Ignore malformed configured origin entries
    }
  }

  // Never trust an arbitrary client-supplied X-Forwarded-Host unless it matches Host or an explicitly allowlisted host
  const candidateForwardedHost = normalizeHostValue(input.forwardedHostHeader);
  const trustedForwardedHost =
    candidateForwardedHost &&
    (candidateForwardedHost === primaryHost || allowlistHosts.has(candidateForwardedHost))
      ? candidateForwardedHost
      : '';
  const trustedHosts = new Set<string>([primaryHost, trustedForwardedHost].filter(Boolean));

  let originMatchesTrusted = false;
  let normalizedOrigin = '';

  if (originRaw) {
    if (originRaw === 'null') {
      originMatchesTrusted = false;
    } else {
      try {
        const parsedOrigin = new URL(originRaw);
        normalizedOrigin = parsedOrigin.origin;
        const originHost = parsedOrigin.host.toLowerCase();
        if (trustedHosts.has(originHost) || allowlist.has(parsedOrigin.origin.toLowerCase())) {
          originMatchesTrusted = true;
        }
      } catch {
        originMatchesTrusted = false;
      }
    }
  }

  if (CSRF_EXEMPT_PATHS.has(path)) {
    return { allowed: true };
  }

  const isMutating =
    method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

  if (originRaw && !originMatchesTrusted) {
    if (isMutating || method === 'OPTIONS') {
      return {
        allowed: false,
        statusCode: 403,
        errorCode: 'csrf_origin_mismatch',
      };
    }
    // Safe GET/HEAD from untrusted origin: do not reflect CORS headers
    return { allowed: true };
  }

  // Fallback Referer origin validation when Origin header is omitted on state-changing requests
  if (isMutating && !originRaw && refererRaw) {
    try {
      const parsedReferer = new URL(refererRaw);
      const refHost = parsedReferer.host.toLowerCase();
      if (!trustedHosts.has(refHost) && !allowlist.has(parsedReferer.origin.toLowerCase())) {
        return {
          allowed: false,
          statusCode: 403,
          errorCode: 'csrf_referer_mismatch',
        };
      }
    } catch {
      return {
        allowed: false,
        statusCode: 403,
        errorCode: 'csrf_invalid_referer',
      };
    }
  }

  const secFetchSite = String(input.secFetchSiteHeader || '').trim().toLowerCase();
  if (isMutating && !originRaw && secFetchSite === 'cross-site') {
    return {
      allowed: false,
      statusCode: 403,
      errorCode: 'csrf_cross_site_blocked',
    };
  }

  return {
    allowed: true,
    corsOriginToReflect: originMatchesTrusted ? normalizedOrigin : undefined,
  };
}

/**
 * Extracts a spoof-resistant client IP key behind a single trusted ingress proxy (e.g. Cloud Run).
 * Uses the rightmost valid IP appended by the ingress proxy in X-Forwarded-For rather than index [0],
 * which can be forged by an unauthenticated caller to evade IP rate limiting.
 */
export function extractClientIpKey(params: {
  xForwardedFor?: string;
  reqIp?: string;
  remoteAddress?: string;
}): string {
  const rawXff = String(params.xForwardedFor || '').trim();
  if (rawXff) {
    const hops = rawXff
      .split(',')
      .map((s) => s.trim().replace(/^::ffff:/i, ''))
      .filter((s) => net.isIP(s) !== 0);
    if (hops.length > 0) {
      return hops[hops.length - 1]!;
    }
  }
  const fallback = String(params.reqIp || params.remoteAddress || '')
    .trim()
    .replace(/^::ffff:/i, '');
  return fallback && net.isIP(fallback) !== 0 ? fallback : fallback || 'anon';
}

/**
 * Blocks direct HTTP access to server source files, security rule definitions, runtime state,
 * dotfiles, source maps, build scripts, and internal archives across both dev and production servers.
 */
export function isBlockedSensitiveHttpPath(rawRequestPath: string): boolean {
  let decoded = String(rawRequestPath || '').split('?')[0] || '/';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return true;
  }
  const normalized = decoded.replace(/\\/g, '/').toLowerCase();

  if (normalized.includes('\0') || normalized.includes('..')) {
    return true;
  }
  if (normalized.endsWith('.map')) {
    return true;
  }

  // Allow Vite's dev-server pre-bundled dependency cache (/node_modules/.vite/deps/*)
  if (normalized.startsWith('/node_modules/.vite/')) {
    return false;
  }

  // Block hidden dotfiles/directories (/.env*, /.bexora-runtime/*, /.git*, /.htaccess, /.aistudio*, /.playwright-cli*)
  // while preserving Vite's internal virtual module prefixes (/@vite/*, /@react-refresh, /@fs/*, /@id/*)
  const segments = normalized.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg.startsWith('.')) {
      return true;
    }
  }

  // Block direct access to server code, security rules, lockfiles, and unauthenticated admin deployment zip
  if (
    normalized === '/server.ts' ||
    normalized === '/server.js' ||
    normalized.startsWith('/src/server/') ||
    normalized === '/src/server' ||
    normalized.startsWith('/scripts/') ||
    normalized === '/scripts' ||
    normalized === '/firestore.rules' ||
    normalized.startsWith('/firestore.rules.') ||
    normalized === '/storage.rules' ||
    normalized === '/firebase-blueprint.json' ||
    normalized === '/security_spec.md' ||
    normalized === '/package.json' ||
    normalized === '/package-lock.json' ||
    normalized === '/bun.lock' ||
    normalized === '/tsconfig.json' ||
    normalized === '/vite.config.ts' ||
    normalized === '/eslint.config.js' ||
    normalized === '/bexora_infinityfree_production.zip'
  ) {
    return true;
  }

  // Also block Vite /@fs/ bypass attempts targeting any sensitive server/runtime/config file
  if (normalized.startsWith('/@fs/')) {
    if (
      normalized.includes('/.env') ||
      normalized.includes('/.bexora-runtime') ||
      normalized.includes('/server.ts') ||
      normalized.includes('/src/server/') ||
      normalized.includes('/firestore.rules') ||
      normalized.includes('/storage.rules') ||
      normalized.includes('/scripts/') ||
      normalized.includes('bexora_infinityfree_production.zip')
    ) {
      return true;
    }
  }

  return false;
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

export function isPrivateOrReservedIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return true;
  const [a, b, c] = octets;

  if (a === 0) return true; // 0.0.0.0/8 current network
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF / TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast & reserved

  return false;
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const cleaned = String(rawIp || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!
    .toLowerCase();
  if (!cleaned) return true;

  const ipVersion = net.isIP(cleaned);
  if (ipVersion === 4) {
    return isPrivateOrReservedIpv4(cleaned);
  }
  if (ipVersion !== 6) {
    return true;
  }

  if (cleaned === '::' || cleaned === '::1' || cleaned === '0:0:0:0:0:0:0:1' || cleaned === '0:0:0:0:0:0:0:0') {
    return true;
  }

  // Dotted IPv4-mapped or IPv4-compatible IPv6 (e.g. ::ffff:127.0.0.1 or ::127.0.0.1)
  const lastColon = cleaned.lastIndexOf(':');
  if (lastColon !== -1 && cleaned.slice(lastColon + 1).includes('.')) {
    const embeddedV4 = cleaned.slice(lastColon + 1);
    return isPrivateOrReservedIpv4(embeddedV4);
  }

  // Hex-encoded IPv4-mapped IPv6 normalized by URL parser (e.g. ::ffff:7f00:1 or ::ffff:a9fe:a9fe)
  const v4MappedHexMatch = cleaned.match(/^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4MappedHexMatch) {
    const hi = parseInt(v4MappedHexMatch[1]!, 16);
    const lo = parseInt(v4MappedHexMatch[2]!, 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateOrReservedIpv4(v4);
  }

  // fc00::/7 Unique Local (fc00..fdff)
  if (/^f[cd][0-9a-f]{0,2}:/.test(cleaned)) return true;
  // fe80::/10 Link-Local (fe80..febf)
  if (/^fe[89ab][0-9a-f]?:/.test(cleaned)) return true;
  // ff00::/8 Multicast
  if (cleaned.startsWith('ff')) return true;
  // 64:ff9b::/96 NAT64 well-known prefix & 2001:db8::/32 documentation
  if (cleaned.startsWith('64:ff9b:') || cleaned.startsWith('2001:db8:')) return true;

  return false;
}

export function validateSafeExternalHttpsUrl(
  rawUrl: string,
  maxLength = 240
): { valid: boolean; normalizedUrl: string; hostname: string; error?: string } {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return { valid: false, normalizedUrl: '', hostname: '', error: 'External HTTPS URL is empty.' };
  }
  if (trimmed.length > maxLength) {
    return {
      valid: false,
      normalizedUrl: '',
      hostname: '',
      error: `External HTTPS URL exceeds ${maxLength} characters.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, normalizedUrl: '', hostname: '', error: 'Invalid URL format.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, normalizedUrl: '', hostname: '', error: 'Only https:// URLs are allowed.' };
  }
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      normalizedUrl: '',
      hostname: '',
      error: 'Embedded credentials are forbidden in external URLs.',
    };
  }
  if (parsed.port && parsed.port !== '443') {
    return {
      valid: false,
      normalizedUrl: '',
      hostname: '',
      error: 'Non-standard ports are forbidden; use standard HTTPS port 443.',
    };
  }

  const rawHost = parsed.hostname.toLowerCase();
  const bareHost = rawHost.replace(/^\[|\]$/g, '');

  if (
    !bareHost ||
    bareHost === 'localhost' ||
    bareHost.endsWith('.localhost') ||
    bareHost.endsWith('.local') ||
    bareHost.endsWith('.internal') ||
    bareHost.endsWith('.home.arpa') ||
    bareHost === 'metadata' ||
    bareHost === 'metadata.google.internal'
  ) {
    return {
      valid: false,
      normalizedUrl: '',
      hostname: bareHost,
      error: 'Private, loopback, or cloud metadata hostnames are forbidden.',
    };
  }

  // Block integer/hex/octal IPv4 encodings or single-label internal hostnames
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(bareHost)) {
    return {
      valid: false,
      normalizedUrl: '',
      hostname: bareHost,
      error: 'Numeric IP encodings are forbidden.',
    };
  }

  if (net.isIP(bareHost) !== 0 || rawHost.startsWith('[')) {
    if (isPrivateOrReservedIp(bareHost)) {
      return {
        valid: false,
        normalizedUrl: '',
        hostname: bareHost,
        error: 'Private or reserved IP addresses are forbidden.',
      };
    }
  } else if (!bareHost.includes('.')) {
    return {
      valid: false,
      normalizedUrl: '',
      hostname: bareHost,
      error: 'Single-label internal hostnames are forbidden.',
    };
  }

  const normalizedUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  return { valid: true, normalizedUrl, hostname: bareHost };
}

export async function assertSafeExternalHttpsDestination(
  rawUrl: string,
  maxLength = 300,
  resolver: (hostname: string) => Promise<Array<{ address: string; family: number }>> = (h) =>
    dns.lookup(h, { all: true, verbatim: true })
): Promise<{ ok: boolean; normalizedUrl: string; error?: string }> {
  const staticCheck = validateSafeExternalHttpsUrl(rawUrl, maxLength);
  if (!staticCheck.valid) {
    return { ok: false, normalizedUrl: '', error: staticCheck.error };
  }

  if (net.isIP(staticCheck.hostname) !== 0) {
    return { ok: true, normalizedUrl: staticCheck.normalizedUrl };
  }

  try {
    const records = await resolver(staticCheck.hostname);
    if (!Array.isArray(records) || records.length === 0) {
      return { ok: false, normalizedUrl: '', error: 'Destination hostname could not be resolved.' };
    }
    for (const rec of records) {
      if (!rec?.address || isPrivateOrReservedIp(rec.address)) {
        return {
          ok: false,
          normalizedUrl: '',
          error: 'Destination hostname resolved to a forbidden private or reserved IP address.',
        };
      }
    }
    return { ok: true, normalizedUrl: staticCheck.normalizedUrl };
  } catch {
    return { ok: false, normalizedUrl: '', error: 'DNS resolution failed for external destination.' };
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly maxTrackedKeys = 4000
  ) {}

  consume(rawKey: string, nowMs = Date.now()): RateLimitDecision {
    const key = String(rawKey || 'anon').slice(0, 160);
    const existing = this.buckets.get(key);

    if (!existing || nowMs >= existing.resetAtMs) {
      if (!existing && this.buckets.size >= this.maxTrackedKeys) {
        this.prune(nowMs);
      }
      this.buckets.set(key, { count: 1, resetAtMs: nowMs + this.windowMs });
      return {
        allowed: true,
        limit: this.maxRequests,
        remaining: Math.max(0, this.maxRequests - 1),
        retryAfterSeconds: Math.ceil(this.windowMs / 1000),
      };
    }

    if (existing.count >= this.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000));
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - existing.count),
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
    };
  }

  private prune(nowMs: number): void {
    for (const [k, v] of this.buckets) {
      if (nowMs >= v.resetAtMs) {
        this.buckets.delete(k);
      }
    }
    if (this.buckets.size >= this.maxTrackedKeys) {
      const firstKey = this.buckets.keys().next().value;
      if (firstKey !== undefined) {
        this.buckets.delete(firstKey);
      }
    }
  }
}

const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function sanitizeJsonPayload<T = unknown>(value: T, depth = 0): T {
  if (depth > 12 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonPayload(item, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) continue;
      clean[key] = sanitizeJsonPayload(val, depth + 1);
    }
    return clean as T;
  }
  return value;
}

export function decodeJwtClaimsUnverified(
  idToken: string
): { alg?: string; aud?: string; iss?: string; iat?: number; exp?: number; sub?: string } | null {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  try {
    const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const header = JSON.parse(headerJson) as Record<string, unknown>;
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return {
      alg: typeof header.alg === 'string' ? header.alg : undefined,
      aud: typeof parsed.aud === 'string' ? parsed.aud : undefined,
      iss: typeof parsed.iss === 'string' ? parsed.iss : undefined,
      iat: typeof parsed.iat === 'number' ? parsed.iat : undefined,
      exp: typeof parsed.exp === 'number' ? parsed.exp : undefined,
      sub: typeof parsed.sub === 'string' ? parsed.sub : undefined,
    };
  } catch {
    return null;
  }
}

export function isLookupAccountActiveAndUnrevoked(params: {
  idToken: string;
  expectedProjectId: string;
  expectedUid?: string;
  disabled?: boolean;
  validSinceSecondsRaw?: string | number;
  nowSeconds?: number;
}): boolean {
  if (params.disabled === true) {
    return false;
  }
  const expectedProject = String(params.expectedProjectId || '').trim();
  if (!expectedProject) {
    return false;
  }
  const claims = decodeJwtClaimsUnverified(params.idToken);
  if (!claims) return false;
  if (claims.alg !== 'RS256') {
    return false;
  }
  if (!claims.aud || claims.aud !== expectedProject) {
    return false;
  }
  if (!claims.iss || claims.iss !== `https://securetoken.google.com/${expectedProject}`) {
    return false;
  }
  if (!claims.sub || claims.sub.length > 128) {
    return false;
  }
  if (params.expectedUid && claims.sub !== params.expectedUid) {
    return false;
  }
  const nowSec = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp < nowSec - 30) {
    return false;
  }
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > nowSec + 60) {
    return false;
  }
  const validSinceSec = Number(params.validSinceSecondsRaw || 0);
  if (Number.isFinite(validSinceSec) && validSinceSec > 0 && claims.iat < validSinceSec) {
    return false;
  }
  return true;
}

export type SecurityEventType =
  | 'auth_failure'
  | 'admin_denied'
  | 'csrf_blocked'
  | 'rate_limited'
  | 'ssrf_blocked'
  | 'webhook_rejected'
  | 'payload_rejected'
  | 'admin_action';

export interface SecurityAuditEvent {
  id: string;
  type: SecurityEventType;
  endpoint: string;
  actor: string;
  summary: string;
  timestampIso: string;
}

const MAX_SECURITY_EVENTS = 250;
const recentSecurityEvents: SecurityAuditEvent[] = [];

export function redactSecretsFromLogText(raw: string): string {
  return String(raw || '')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z_\-]{25,45}/g, '[REDACTED_API_KEY]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .slice(0, 320);
}

export function recordSecurityEvent(event: {
  type: SecurityEventType;
  endpoint: string;
  actor?: string;
  summary: string;
}): SecurityAuditEvent {
  const entry: SecurityAuditEvent = {
    id: `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: event.type,
    endpoint: String(event.endpoint || '').slice(0, 120),
    actor: redactSecretsFromLogText(event.actor || 'anonymous').slice(0, 80),
    summary: redactSecretsFromLogText(event.summary),
    timestampIso: new Date().toISOString(),
  };
  recentSecurityEvents.unshift(entry);
  if (recentSecurityEvents.length > MAX_SECURITY_EVENTS) {
    recentSecurityEvents.length = MAX_SECURITY_EVENTS;
  }
  return entry;
}

export function getRecentSecurityEvents(limit = 40): SecurityAuditEvent[] {
  return recentSecurityEvents.slice(0, Math.max(1, Math.min(100, limit)));
}

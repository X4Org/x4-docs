import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';

const BODY_LIMIT = 16 * 1024;
const GATEWAY_BODY_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_LOCAL_RECORDS = 1_000;

function secureOrigin(url) {
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || (isIP(url.hostname) === 4 && url.hostname.split('.')[0] === '127');
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
    && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function randomValue() {
  return randomBytes(32).toString('base64url');
}

function safeCookieId(id) {
  const raw = String(id);
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
  if (safe === raw && safe) return safe;
  return `${safe || 'preview'}_${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    // Reject ambiguity from duplicate names instead of trusting header order.
    cookies.set(name, cookies.has(name) ? null : value);
  }
  return cookies;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function publicIdentity(value) {
  if (!value || typeof value.sub !== 'string' || !value.sub) {
    throw new HttpError(503, 'The authentication gateway returned an invalid identity.');
  }
  const identity = { sub: value.sub };
  for (const key of ['name', 'email', 'iss']) {
    if (typeof value[key] === 'string') identity[key] = value[key];
  }
  return identity;
}

function validExpiry(value) {
  if (!Number.isFinite(value) || value <= Date.now()) {
    throw new HttpError(503, 'The authentication gateway returned an expired session.');
  }
  return value;
}

function redirectUrl(value, gatewayUrl) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.origin !== new URL(gatewayUrl).origin) {
      throw new Error('Invalid redirect');
    }
    return url.href;
  } catch {
    throw new HttpError(503, 'The authentication gateway returned an invalid redirect.');
  }
}

async function readLimitedBody(stream, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A minimal K12-style backend adapter for the gateway proof of concept.
 * This demonstrates preview sessions; it does not implement BTA authorization.
 * Set config.baseUrl to this server's external origin before its first request.
 */
export function createPreview(config) {
  const transactions = new Map();
  const sessions = new Map();
  const cookiePrefix = `x4_${safeCookieId(config.id)}`;
  const sessionCookieName = `${cookiePrefix}_session`;

  function baseUrl() {
    try {
      const url = new URL(config.baseUrl);
      if (!secureOrigin(url)) {
        throw new Error('Invalid preview URL');
      }
      return url;
    } catch {
      throw new HttpError(503, 'The preview external URL is not configured.');
    }
  }

  function cookie(name, value, { path = '/', maxAge = 0 } = {}) {
    const secure = baseUrl().protocol === 'https:';
    if (secure) path = '/';
    return `${cookieName(name)}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure ? '; Secure' : ''}`;
  }

  function cookieName(name) {
    // Sibling previews must not be able to inject a parent-domain session or
    // callback cookie. __Host- requires Secure, Path=/ and no Domain attribute.
    return baseUrl().protocol === 'https:' ? `__Host-${name}` : name;
  }

  function readCookie(request, name) {
    return parseCookies(request.headers.cookie).get(cookieName(name));
  }

  function addCookie(response, value) {
    const existing = response.getHeader('Set-Cookie');
    response.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : existing ? [existing] : []), value]);
  }

  function clearSession(response) {
    addCookie(response, cookie(sessionCookieName, '', { maxAge: 0 }));
  }

  function clearTransactionCookie(response, transactionId) {
    addCookie(response, cookie(`${cookiePrefix}_login_${transactionId}`, '', {
      path: '/auth/callback', maxAge: 0,
    }));
  }

  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }

  function redirect(response, destination) {
    response.writeHead(303, { Location: destination });
    response.end();
  }

  function requireSameOrigin(request) {
    const expected = baseUrl().origin;
    const supplied = request.headers.origin ?? request.headers.referer;
    try {
      if (typeof supplied !== 'string' || new URL(supplied).origin !== expected) {
        throw new Error('Origin mismatch');
      }
    } catch {
      throw new HttpError(403, 'This action must originate from this preview.');
    }
  }

  function purgeExpired() {
    const now = Date.now();
    for (const [key, value] of transactions) {
      if (value.expiresAt <= now) transactions.delete(key);
    }
    for (const [key, value] of sessions) {
      if (value.expiresAt <= now) sessions.delete(key);
    }
  }

  async function gatewayPost(path, value) {
    let gateway;
    try {
      const gatewayOrigin = new URL(config.gatewayUrl);
      const url = new URL(path, gatewayOrigin);
      if (!secureOrigin(gatewayOrigin)
        || typeof config.redeemSecret !== 'string' || !config.redeemSecret) {
        throw new Error('Invalid gateway configuration');
      }
      gateway = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.redeemSecret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ previewId: config.id, generation: config.generation, ...value }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!gateway.ok) {
        await gateway.body?.cancel();
        throw new Error('Gateway request rejected');
      }
      return JSON.parse(await readLimitedBody(gateway.body, GATEWAY_BODY_LIMIT));
    } catch {
      // Never expose gateway responses, credentials, tickets, or tokens in errors.
      throw new HttpError(503, 'The authentication gateway could not complete this request.');
    }
  }

  async function currentSession(request, response) {
    const key = readCookie(request, sessionCookieName);
    if (!key) return null;
    const session = sessions.get(key);
    if (!session || session.expiresAt <= Date.now() || session.generation !== config.generation) {
      sessions.delete(key);
      clearSession(response);
      return null;
    }
    // Gateway validation is mandatory. An outage fails closed, without rendering
    // the remembered identity as an authenticated session.
    const result = await gatewayPost('/session/validate', { sessionId: session.gatewaySessionId });
    if (result.active !== true) {
      sessions.delete(key);
      clearSession(response);
      return null;
    }
    session.identity = publicIdentity(result.identity);
    session.expiresAt = validExpiry(result.expiresAt);
    return { key, ...session };
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Do not restrict form-action to 'self': browsers can apply that policy to
    // the cross-origin redirects needed by the gateway and OIDC provider.
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    purgeExpired();

    const url = new URL(request.url, baseUrl());
    if (request.headers.host !== baseUrl().host) throw new HttpError(400, 'Unexpected preview host.');
    if (url.origin !== baseUrl().origin) throw new HttpError(400, 'Invalid request URL.');
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { ok: true, previewId: config.id, generation: config.generation });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/login') {
      requireSameOrigin(request);
      await readLimitedBody(request, BODY_LIMIT);
      if (transactions.size >= MAX_LOCAL_RECORDS) throw new HttpError(503, 'Too many pending logins. Try again later.');
      const transactionId = randomValue();
      const verifier = randomValue();
      const browserSecret = randomValue();
      const ttl = Number.isFinite(config.transactionTtlMs) && config.transactionTtlMs > 0
        ? Math.min(config.transactionTtlMs, 300_000) : 300_000;
      const transaction = {
        verifier, browserSecret, generation: config.generation, expiresAt: Date.now() + ttl,
      };
      transactions.set(transactionId, transaction);
      try {
        const result = await gatewayPost('/login/start', {
          returnState: transactionId,
          challenge: createHash('sha256').update(verifier).digest('base64url'),
        });
        const destination = redirectUrl(result.loginUrl, config.gatewayUrl);
        addCookie(response, cookie(`${cookiePrefix}_login_${transactionId}`, browserSecret, {
          path: '/auth/callback', maxAge: Math.ceil(ttl / 1000),
        }));
        redirect(response, destination);
      } catch (error) {
        transactions.delete(transactionId);
        throw error;
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/auth/callback') {
      const transactionId = url.searchParams.get('transaction');
      const ticket = url.searchParams.get('ticket');
      if (!transactionId || !/^[A-Za-z0-9_-]{43}$/.test(transactionId)
        || url.searchParams.getAll('transaction').length !== 1) {
        throw new HttpError(400, 'The login callback has no valid browser transaction.');
      }
      clearTransactionCookie(response, transactionId);
      const transaction = transactions.get(transactionId);
      const browserSecret = readCookie(request, `${cookiePrefix}_login_${transactionId}`);
      if (!transaction || transaction.expiresAt <= Date.now() || transaction.generation !== config.generation
        || !constantTimeEqual(browserSecret, transaction.browserSecret)) {
        throw new HttpError(400, 'The login callback does not match this browser. Start login again.');
      }
      if (!ticket || ticket.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(ticket)
        || url.searchParams.getAll('ticket').length !== 1) {
        transactions.delete(transactionId);
        throw new HttpError(400, 'The login callback has no valid handoff ticket.');
      }
      // Consume before awaiting redemption so concurrent callbacks cannot reuse it.
      transactions.delete(transactionId);
      if (sessions.size >= MAX_LOCAL_RECORDS) throw new HttpError(503, 'Too many preview sessions. Try again later.');
      const result = await gatewayPost('/handoff/redeem', { ticket, verifier: transaction.verifier });
      if (typeof result.sessionId !== 'string' || !result.sessionId) {
        throw new HttpError(503, 'The authentication gateway returned an invalid session.');
      }
      const identity = publicIdentity(result.identity);
      const expiresAt = validExpiry(result.expiresAt);
      const localSessionId = randomValue();
      const previousKey = readCookie(request, sessionCookieName);
      if (previousKey) sessions.delete(previousKey);
      sessions.set(localSessionId, {
        gatewaySessionId: result.sessionId, identity, expiresAt, generation: config.generation,
      });
      addCookie(response, cookie(sessionCookieName, localSessionId, {
        maxAge: Math.ceil((expiresAt - Date.now()) / 1000),
      }));
      redirect(response, '/');
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/session')) {
      const session = await currentSession(request, response);
      if (url.pathname === '/session') {
        json(response, 200, session
          ? { authenticated: true, identity: session.identity }
          : { authenticated: false });
        return;
      }
      const content = session
        ? `<p>Signed in as <strong>${escapeHtml(session.identity.name || session.identity.email || session.identity.sub)}</strong>.</p><pre>${escapeHtml(JSON.stringify(session.identity, null, 2))}</pre><form action="/logout" method="post"><button type="submit">Sign out</button></form>`
        : '<p>You are not signed in.</p><form action="/login" method="post"><button type="submit">Sign in</button></form>';
      // Navigation POSTs under no-referrer can carry Origin: null. Preserve the
      // same-origin form check while suppressing referrers to other origins.
      // Callback/redirect responses keep the stricter no-referrer policy above.
      response.setHeader('Referrer-Policy', 'same-origin');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(config.id)} — authentication demo</title></head><body><h1>${escapeHtml(config.id)}</h1><p><strong>X4 authentication proof of concept.</strong> CoreLayer and BTA integration have not been validated.</p>${content}</body></html>`);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/logout') {
      requireSameOrigin(request);
      await readLimitedBody(request, BODY_LIMIT);
      const key = readCookie(request, sessionCookieName);
      const session = key ? sessions.get(key) : null;
      if (key) sessions.delete(key);
      clearSession(response);
      if (!session || session.generation !== config.generation) {
        redirect(response, '/');
        return;
      }
      const result = await gatewayPost('/session/logout', { sessionId: session.gatewaySessionId });
      redirect(response, redirectUrl(result.logoutUrl, config.gatewayUrl));
      return;
    }

    throw new HttpError(404, 'Not found.');
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      json(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : 'The preview could not complete this request.',
      });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => {
    transactions.clear();
    sessions.clear();
  });
  return server;
}

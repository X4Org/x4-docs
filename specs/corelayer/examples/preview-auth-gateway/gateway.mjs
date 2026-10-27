import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import * as oidc from 'openid-client';

const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(value);

export function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
}

function safeOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))) {
    throw new Error('Use an HTTPS origin, or HTTP on loopback for the local demo.');
  }
  return url.origin;
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) fail(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object.');
    return value;
  }
  catch { fail(400, 'Expected JSON.'); }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function redirect(res, url) {
  res.writeHead(303, { Location: String(url) });
  res.end();
}

function bindingCookieName(origin, name) {
  return origin.startsWith('https:') ? `__Host-${name}` : name;
}

function cookie(req, origin, name) {
  name = bindingCookieName(origin, name);
  const parts = (req.headers.cookie || '').split(';').map(part => part.trim());
  const matches = parts.filter(part => part.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
}

function setCookie(res, origin, name, value, path, maxAge) {
  name = bindingCookieName(origin, name);
  // HTTPS previews are sibling subdomains. __Host- forbids parent-domain
  // injection; browsers require Secure, no Domain, and Path=/ for this prefix.
  if (origin.startsWith('https:')) path = '/';
  res.appendHeader('Set-Cookie', `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`);
}

/** Standalone example broker. All state is in memory and lost on restart. */
export function createGateway(config) {
  if (!config.clientId || !config.clientSecret || typeof config.registrationToken !== 'string' || config.registrationToken.length < 32)
    throw new Error('Set client credentials and a registration token of at least 32 characters.');
  safeOrigin(config.baseUrl);
  const issuer = new URL(config.issuerUrl);
  if (issuer.username || issuer.password || issuer.search || issuer.hash ||
      (issuer.protocol !== 'https:' && !(issuer.protocol === 'http:' && isLoopback(issuer.hostname))))
    throw new Error('The OIDC issuer must use HTTPS, or loopback HTTP for the local demo.');
  const now = config.clock || Date.now;
  const previews = new Map();
  const stores = Object.fromEntries(['starts', 'logins', 'tickets', 'sessions', 'logoutStarts', 'logouts'].map(name => [name, new Map()]));
  let discovery;

  async function provider() {
    if (!discovery) {
      discovery = oidc.discovery(issuer, config.clientId, { client_secret: config.clientSecret },
        oidc.ClientSecretBasic(config.clientSecret), {
          timeout: 5,
          execute: issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [],
        }).then(result => {
          // Verify signatures using provider JWKS even for ID tokens from the token endpoint.
          oidc.enableNonRepudiationChecks(result);
          return result;
        }).catch(() => { discovery = undefined; fail(503, 'OIDC provider discovery is unavailable.'); });
    }
    return discovery;
  }

  function purgePreview(id) {
    for (const map of Object.values(stores)) {
      for (const [key, value] of map) if (value.previewId === id) map.delete(key);
    }
  }

  function sweep() {
    for (const [id, preview] of previews) {
      if (preview.expiresAt <= now()) { previews.delete(id); purgePreview(id); }
    }
    for (const map of Object.values(stores)) {
      for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
    }
  }

  function put(store, value, ttl) {
    const map = stores[store];
    if (map.size >= 1000) fail(503, 'Demo state capacity reached.');
    const key = random();
    map.set(key, { ...value, expiresAt: now() + ttl });
    return key;
  }

  function registered(id, generation) {
    const preview = previews.get(id);
    if (!preview || preview.generation !== generation || preview.expiresAt <= now())
      fail(410, 'Preview is stopped, expired, or replaced.');
    return preview;
  }

  function activeTransaction(transaction) {
    if (transaction.expiresAt <= now()) fail(400, 'Authentication transaction has expired.');
    return registered(transaction.previewId, transaction.generation);
  }

  function authenticate(req, id, generation) {
    const preview = registered(id, generation);
    if (!equal(req.headers.authorization, `Bearer ${preview.redeemSecret}`)) fail(401, 'Invalid preview credential.');
    return preview;
  }

  function admin(req) {
    if (!equal(req.headers.authorization, `Bearer ${config.registrationToken}`)) fail(401, 'Invalid registration credential.');
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    try {
      sweep();
      const origin = safeOrigin(config.baseUrl);
      if (req.headers.host !== new URL(origin).host) fail(400, 'Unexpected host.');
      const url = new URL(req.url, origin);
      if (url.origin !== origin) fail(400, 'Unexpected origin.');
      const endpoint = `${req.method} ${url.pathname}`;
      if (endpoint === 'GET /health') return json(res, 200, { status: 'ok', mode: 'oidc', configured: true });
      if (endpoint === 'GET /readyz') {
        try {
          const metadata = (await provider()).serverMetadata();
          if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri)
            throw new Error('Missing OIDC endpoints.');
          return json(res, 200, { ready: true, configured: true, check: 'oidc-discovery' });
        } catch {
          return json(res, 503, { ready: false, configured: true, error: 'OIDC discovery is unavailable or incomplete.' });
        }
      }
      if (endpoint === 'GET /') return json(res, 200, {
        service: 'X4 preview authentication gateway', mode: 'oidc',
        message: 'Open your preview URL to start sign-in.',
      });
      if (endpoint === 'POST /previews') {
        admin(req);
        const input = await body(req);
        if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) || !opaque(input.generation) ||
            typeof input.redeemSecret !== 'string' || input.redeemSecret.length < 32)
          fail(400, 'Invalid preview registration.');
        let previewOrigin;
        try { previewOrigin = safeOrigin(input.origin); } catch { fail(400, 'Invalid preview origin.'); }
        if (new URL(previewOrigin).hostname === new URL(origin).hostname)
          fail(400, 'Gateway and previews must use separate hostnames.');
        // Browser cookies are scoped to hostnames, not ports. Each active
        // preview must have its own host even when the controller registers it.
        const previewHost = new URL(previewOrigin).hostname;
        for (const entry of previews.values()) {
          if (entry.id !== input.id && entry.expiresAt > now() && new URL(entry.origin).hostname === previewHost)
            fail(409, 'Active previews must use separate hostnames.');
        }
        const leaseMs = input.leaseMs ?? 3_600_000;
        if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000)
          fail(400, 'Lease must be between one second and one hour.');
        const existing = previews.get(input.id);
        if (!existing && previews.size >= 100) fail(503, 'Preview capacity reached.');
        if (existing?.generation === input.generation && (existing.origin !== previewOrigin ||
            !equal(existing.redeemSecret, input.redeemSecret)))
          fail(409, 'A changed origin or credential requires a new preview generation.');
        if (existing && (existing.generation !== input.generation || existing.origin !== previewOrigin ||
            !equal(existing.redeemSecret, input.redeemSecret))) purgePreview(input.id);
        const preview = { id: input.id, generation: input.generation, origin: previewOrigin,
          redeemSecret: input.redeemSecret, expiresAt: now() + leaseMs };
        previews.set(input.id, preview);
        return json(res, 201, { id: preview.id, generation: preview.generation, origin: preview.origin, expiresAt: preview.expiresAt });
      }
      if (req.method === 'DELETE' && /^\/previews\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname)) {
        admin(req);
        const { generation } = await body(req);
        const id = url.pathname.split('/')[2];
        registered(id, generation);
        previews.delete(id);
        purgePreview(id);
        return json(res, 200, { removed: true });
      }
      if (endpoint === 'POST /login/start') {
        const input = await body(req);
        authenticate(req, input.previewId, input.generation);
        if (!opaque(input.returnState) || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) fail(400, 'Invalid browser binding.');
        const request = put('starts', { previewId: input.previewId, generation: input.generation,
          returnState: input.returnState, challenge: input.challenge }, config.transactionTtlMs ?? 300_000);
        return json(res, 200, { loginUrl: `${origin}/login?request=${request}` });
      }
      if (endpoint === 'GET /login') {
        const request = url.searchParams.get('request');
        const start = stores.starts.get(request);
        if (!start) fail(400, 'Invalid or expired login request.');
        registered(start.previewId, start.generation);
        stores.starts.delete(request);
        const verifier = oidc.randomPKCECodeVerifier();
        const nonce = oidc.randomNonce();
        const browser = random();
        const state = put('logins', { ...start, verifier, nonce, browser }, config.transactionTtlMs ?? 300_000);
        const transaction = stores.logins.get(state);
        const client = await provider();
        const challenge = await oidc.calculatePKCECodeChallenge(verifier);
        // Discovery and cryptographic work may yield while a preview expires,
        // stops or is replaced. Recheck immediately before emitting redirects.
        activeTransaction(transaction);
        if (stores.logins.get(state) !== transaction) fail(400, 'Invalid login transaction.');
        const destination = oidc.buildAuthorizationUrl(client, {
          redirect_uri: `${origin}/callback`, scope: config.scope || 'openid profile email', state, nonce,
          code_challenge: challenge, code_challenge_method: 'S256',
          ...(config.audience ? { audience: config.audience } : {}),
        });
        setCookie(res, origin, `x4_oidc_${state}`, browser, '/callback', Math.ceil((config.transactionTtlMs ?? 300_000) / 1000));
        return redirect(res, destination);
      }
      if (endpoint === 'GET /callback') {
        const state = url.searchParams.get('state');
        const transaction = stores.logins.get(state);
        if (!transaction || !equal(cookie(req, origin, `x4_oidc_${state}`), transaction.browser)) fail(400, 'Invalid login transaction or browser.');
        registered(transaction.previewId, transaction.generation);
        stores.logins.delete(state);
        setCookie(res, origin, `x4_oidc_${state}`, '', '/callback', 0);
        let tokens;
        try {
          tokens = await oidc.authorizationCodeGrant(await provider(), url, {
            pkceCodeVerifier: transaction.verifier, expectedState: state, expectedNonce: transaction.nonce,
          });
        } catch { fail(400, 'CoreLayer/OIDC authentication failed.'); }
        const claims = tokens.claims();
        if (!claims?.sub) fail(400, 'Missing OIDC identity.');
        const preview = activeTransaction(transaction);
        const remaining = tokens.expiresIn();
        const tokenLifetime = remaining === undefined ? 300_000 : remaining * 1000;
        if (!Number.isFinite(tokenLifetime) || tokenLifetime <= 0) fail(400, 'OIDC access token has expired.');
        const tokenExpiresAt = now() + tokenLifetime;
        const ticket = put('tickets', { previewId: preview.id, generation: preview.generation, tokenExpiresAt,
          challenge: transaction.challenge, tokens, identity: { sub: claims.sub, iss: claims.iss,
            ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
            ...(typeof claims.email === 'string' ? { email: claims.email } : {}) } }, config.handoffTtlMs ?? 30_000);
        const destination = new URL('/auth/callback', preview.origin);
        destination.searchParams.set('ticket', ticket);
        destination.searchParams.set('transaction', transaction.returnState);
        return redirect(res, destination);
      }
      if (endpoint === 'POST /handoff/redeem') {
        const input = await body(req);
        authenticate(req, input.previewId, input.generation);
        const ticket = stores.tickets.get(input.ticket);
        if (!ticket || ticket.expiresAt <= now() || ticket.tokenExpiresAt <= now() ||
            ticket.previewId !== input.previewId || ticket.generation !== input.generation ||
            typeof input.verifier !== 'string' || !equal(digest(input.verifier), ticket.challenge))
          fail(400, 'Invalid, expired, or already used handoff ticket.');
        // No await between checking and consuming: a ticket is redeemed exactly once.
        stores.tickets.delete(input.ticket);
        const ttl = Math.min(config.sessionTtlMs ?? 900_000, ticket.tokenExpiresAt - now());
        const sessionId = put('sessions', { previewId: ticket.previewId, generation: ticket.generation,
          identity: ticket.identity, tokens: ticket.tokens }, ttl);
        const session = stores.sessions.get(sessionId);
        return json(res, 200, { identity: session.identity, sessionId, expiresAt: session.expiresAt });
      }
      if (endpoint === 'POST /session/validate' || endpoint === 'POST /session/logout') {
        const input = await body(req);
        const preview = authenticate(req, input.previewId, input.generation);
        const session = stores.sessions.get(input.sessionId);
        const active = session && session.expiresAt > now() && session.previewId === preview.id && session.generation === preview.generation;
        if (endpoint === 'POST /session/validate') return json(res, 200, active ?
          { active: true, identity: session.identity, expiresAt: session.expiresAt } : { active: false });
        if (!active) fail(400, 'Invalid session.');
        stores.sessions.delete(input.sessionId);
        const request = put('logoutStarts', { previewId: preview.id, generation: preview.generation,
          idToken: session.tokens.id_token }, 60_000);
        return json(res, 200, { logoutUrl: `${origin}/logout?request=${request}` });
      }
      if (endpoint === 'GET /logout') {
        const request = url.searchParams.get('request');
        const start = stores.logoutStarts.get(request);
        if (!start) fail(400, 'Invalid logout request.');
        registered(start.previewId, start.generation);
        stores.logoutStarts.delete(request);
        const browser = random();
        const state = put('logouts', { ...start, browser }, 60_000);
        const transaction = stores.logouts.get(state);
        const client = await provider();
        activeTransaction(transaction);
        if (stores.logouts.get(state) !== transaction) fail(400, 'Invalid logout transaction.');
        const destination = oidc.buildEndSessionUrl(client, {
          id_token_hint: start.idToken, post_logout_redirect_uri: `${origin}/logout-callback`, state,
        });
        setCookie(res, origin, `x4_logout_${state}`, browser, '/logout-callback', 60);
        return redirect(res, destination);
      }
      if (endpoint === 'GET /logout-callback') {
        const state = url.searchParams.get('state');
        const transaction = stores.logouts.get(state);
        if (!transaction || !equal(cookie(req, origin, `x4_logout_${state}`), transaction.browser)) fail(400, 'Invalid logout transaction or browser.');
        const preview = registered(transaction.previewId, transaction.generation);
        stores.logouts.delete(state);
        setCookie(res, origin, `x4_logout_${state}`, '', '/logout-callback', 0);
        return redirect(res, preview.origin);
      }
      fail(404, 'Unknown endpoint.');
    } catch (error) {
      // Deliberately avoid logging request URLs, credentials, codes, tickets, or tokens.
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Gateway request failed.' });
      else res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on('close', () => {
    previews.clear();
    for (const map of Object.values(stores)) map.clear();
  });
  return server;
}

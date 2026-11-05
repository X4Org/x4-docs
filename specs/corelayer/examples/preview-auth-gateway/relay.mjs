import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isLoopback } from './gateway.mjs';

// OIDC relay: one fixed, X4-owned pair of callbacks for every preview, with no
// change to the application.
//
// The application keeps its own public OIDC client and PKCE. X4 sets its issuer
// to https://auth.x4app.dev/p/<provider>, which serves the provider's discovery
// document with the authorization, token and end-session endpoints pointing
// here. The relay then:
//   - /authorize: checks redirect_uri is a preview callback, swaps in
//     <base>/callback, wraps the app's state (preview callback + original state,
//     signed) and redirects to the provider;
//   - /callback: unwraps the state and redirects to the preview callback with
//     the original state and the rest of the query unchanged;
//   - /token: swaps the preview callback back to <base>/callback so the code
//     exchange matches, and forwards the request server-side (no provider CORS);
//   - /logout and /logout-callback: the same for RP-initiated logout;
//   - /exchange (optional): forwards the portal token exchange server-side.
// Tokens pass through but are never stored or logged. Codes are useless
// without the PKCE verifier, which stays in the preview's browser.

export const DEFAULT_RELAY_HOST_SUFFIX = '.preview.x4app.dev';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PROVIDER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const STATE_PREFIX = 'x4r1.';
const STATE_LIFETIME_MS = 30 * 60_000;
const DISCOVERY_CACHE_MS = 5 * 60_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_BODY = 16_384;
const MAX_UPSTREAM_BODY = 262_144;
const FORM = 'application/x-www-form-urlencoded';
const GRANTS = Object.freeze({
  token: ['authorization_code', 'refresh_token'],
  exchange: ['urn:ietf:params:oauth:grant-type:token-exchange'],
});

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** A host suffix such as `.preview.x4app.dev`: previews are one label under it. */
export function relayHostSuffix(value = DEFAULT_RELAY_HOST_SUFFIX) {
  const labels = typeof value === 'string' && value.startsWith('.') ? value.slice(1).split('.') : [];
  if (labels.length < 2 || !labels.every(label => LABEL.test(label)))
    throw new Error('X4_AUTH_RELAY_HOST_SUFFIX must look like .preview.example.com.');
  return value;
}

function upstreamUrl(value, what) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${what} must be a URL.`); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))))
    throw new Error(`${what} must be an HTTPS URL without credentials, query or fragment.`);
  return url.href.replace(/\/$/, '');
}

/**
 * Providers as JSON: {"<name>": {"issuer": "...", "tokenExchange": "..."?}}.
 * The application's issuer becomes <base>/p/<name>.
 */
export function relayProviders(text) {
  let value;
  try { value = JSON.parse(text); } catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length)
    throw new Error('Set X4_AUTH_RELAY_PROVIDERS to JSON such as {"corelayer-testing":{"issuer":"https://..."}}.');
  return Object.fromEntries(Object.entries(value).map(([name, provider]) => {
    if (!PROVIDER_NAME.test(name)) throw new Error(`Relay provider name "${name}" must be lowercase letters, digits and dashes.`);
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new Error(`Relay provider ${name} must be an object.`);
    const unknown = Object.keys(provider).filter(key => !['issuer', 'tokenExchange'].includes(key));
    if (unknown.length) throw new Error(`Relay provider ${name} has unknown settings: ${unknown.join(', ')}.`);
    return [name, Object.freeze({
      issuer: upstreamUrl(provider.issuer, `Relay provider ${name} issuer`),
      tokenExchange: provider.tokenExchange === undefined ? undefined
        : upstreamUrl(provider.tokenExchange, `Relay provider ${name} tokenExchange`),
    })];
  }));
}

/** The preview URL, or null unless it is https://<one label><suffix>/<path> exactly. */
export function previewUrl(value, suffix) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return null;
  if (url.href !== value || !url.hostname.endsWith(suffix)) return null;
  return LABEL.test(url.hostname.slice(0, -suffix.length)) ? url : null;
}

const page = (title, message) => '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  `<title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`;

export function createRelayService({ baseUrl, hostSuffix = DEFAULT_RELAY_HOST_SUFFIX, providers,
  stateKey = randomBytes(32), fetchImpl = fetch, now = Date.now }) {
  const origin = new URL(baseUrl);
  const base = origin.origin;
  const suffix = relayHostSuffix(hostSuffix);
  const callback = { login: `${base}/callback`, logout: `${base}/logout-callback` };
  const discoveries = new Map();

  const sign = payload => createHmac('sha256', stateKey).update(payload).digest('base64url');
  function wrapState(kind, provider, target, state) {
    const payload = Buffer.from(JSON.stringify({ k: kind, p: provider, r: target, s: state ?? null, t: now() }))
      .toString('base64url');
    return `${STATE_PREFIX}${payload}.${sign(payload)}`;
  }
  function unwrapState(kind, value) {
    if (typeof value !== 'string' || !value.startsWith(STATE_PREFIX)) return null;
    const [payload, mac, extra] = value.slice(STATE_PREFIX.length).split('.');
    if (!payload || !mac || extra !== undefined) return null;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(mac);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
    if (data?.k !== kind || typeof data.t !== 'number' || now() - data.t > STATE_LIFETIME_MS || now() < data.t - 60_000) return null;
    const target = previewUrl(data.r, suffix);
    if (!target || (data.s !== null && typeof data.s !== 'string')) return null;
    return { target, state: data.s };
  }

  async function upstream(url, init = {}) {
    try {
      return await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch { fail(502, 'The identity provider could not be reached.'); }
  }
  async function readLimited(response) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_UPSTREAM_BODY) fail(502, 'The identity provider response was too large.');
    return text;
  }
  async function discovery(name) {
    const provider = providers[name];
    const cached = discoveries.get(name);
    if (cached && now() - cached.at < DISCOVERY_CACHE_MS) return cached.metadata;
    const response = await upstream(`${provider.issuer}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } });
    if (!response.ok) fail(502, 'The identity provider discovery document is unavailable.');
    let metadata;
    try { metadata = JSON.parse(await readLimited(response)); } catch (error) { if (error.status) throw error; }
    if (!metadata || typeof metadata !== 'object' || metadata.issuer?.replace(/\/$/, '') !== provider.issuer ||
        typeof metadata.authorization_endpoint !== 'string' || typeof metadata.token_endpoint !== 'string')
      fail(502, 'The identity provider discovery document is invalid.');
    discoveries.set(name, { at: now(), metadata });
    return metadata;
  }

  async function form(req) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== FORM) fail(415, `Send ${FORM}.`);
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) fail(413, 'Request too large.');
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString());
  }

  function corsOrigin(req) {
    const value = req.headers.origin;
    const url = previewUrl(`${value}/`, suffix);
    return url && url.origin === value ? value : null;
  }

  async function forwardForm(req, res, endpoint, kind) {
    const allowed = corsOrigin(req);
    if (!allowed) fail(403, 'Requests must come from an X4 preview origin.');
    const cors = { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' };
    // Let the preview read relay errors as well as provider responses.
    for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (req.method !== 'POST') fail(405, 'Method not allowed.');
    const body = await form(req);
    if (!GRANTS[kind].includes(body.get('grant_type'))) fail(400, 'Unsupported grant type.');
    if (body.has('client_secret') || req.headers.authorization) fail(400, 'The relay forwards public-client requests only.');
    if (body.get('grant_type') === 'authorization_code') {
      if (!previewUrl(body.get('redirect_uri'), suffix)) fail(400, 'redirect_uri must be an X4 preview callback.');
      body.set('redirect_uri', callback.login);
    }
    const response = await upstream(endpoint, { method: 'POST',
      headers: { 'Content-Type': FORM, Accept: 'application/json' }, body: body.toString() });
    const text = await readLimited(response);
    res.writeHead(response.status, { ...cors,
      'Content-Type': response.headers.get('content-type') || 'application/json' });
    return res.end(text);
  }

  async function authorize(res, url, name) {
    const params = new URLSearchParams(url.search);
    const target = previewUrl(params.get('redirect_uri'), suffix);
    if (!target) fail(400, 'redirect_uri must be an X4 preview callback.');
    if (params.get('response_type') !== 'code') fail(400, 'Only the authorization code flow is relayed.');
    if (params.has('response_mode') && params.get('response_mode') !== 'query') fail(400, 'Only query responses are relayed.');
    if (!params.get('code_challenge') || params.get('code_challenge_method') !== 'S256') fail(400, 'PKCE with S256 is required.');
    if (!params.get('state')) fail(400, 'state is required.');
    const destination = new URL((await discovery(name)).authorization_endpoint);
    params.set('redirect_uri', callback.login);
    params.set('state', wrapState('login', name, target.href, params.get('state')));
    for (const [key, value] of params) destination.searchParams.append(key, value);
    res.writeHead(303, { Location: destination.href });
    res.end();
  }

  async function logout(res, url, name) {
    const metadata = await discovery(name);
    if (typeof metadata.end_session_endpoint !== 'string') fail(404, 'The identity provider has no logout endpoint.');
    const params = new URLSearchParams(url.search);
    if (params.has('post_logout_redirect_uri')) {
      const target = previewUrl(params.get('post_logout_redirect_uri'), suffix);
      if (!target) fail(400, 'post_logout_redirect_uri must be an X4 preview address.');
      params.set('post_logout_redirect_uri', callback.logout);
      params.set('state', wrapState('logout', name, target.href, params.get('state')));
    }
    const destination = new URL(metadata.end_session_endpoint);
    for (const [key, value] of params) destination.searchParams.append(key, value);
    res.writeHead(303, { Location: destination.href });
    res.end();
  }

  function returnToPreview(res, url, kind) {
    const unwrapped = unwrapState(kind, url.searchParams.get('state'));
    if (!unwrapped) {
      if (kind === 'logout' && !url.searchParams.has('state'))
        return html(res, 200, 'Signed out', 'You are signed out. Return to your preview to sign in again.');
      return html(res, 400, 'Sign-in could not continue',
        'This response does not belong to a current X4 preview sign-in. Start again from your preview.');
    }
    const destination = new URL(unwrapped.target);
    for (const [key, value] of url.searchParams) {
      if (key === 'state') { if (unwrapped.state !== null) destination.searchParams.append(key, unwrapped.state); }
      else destination.searchParams.append(key, value);
    }
    res.writeHead(303, { Location: destination.href });
    res.end();
  }

  function html(res, status, title, message) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(title, message));
  }

  async function route(req, res, url) {
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok', mode: 'relay' });
    if (url.pathname === '/readyz' && req.method === 'GET') {
      const results = await Promise.all(Object.keys(providers).map(name => discovery(name).then(() => true, () => false)));
      return json(res, results.every(Boolean) ? 200 : 503, { ready: results.every(Boolean), mode: 'relay' });
    }
    if (url.pathname === '/' && req.method === 'GET')
      return html(res, 200, 'X4 preview sign-in', 'This address returns sign-in and sign-out to the X4 preview that started them. Open your preview to sign in.');
    if (url.pathname === '/callback' && req.method === 'GET') return returnToPreview(res, url, 'login');
    if (url.pathname === '/logout-callback' && req.method === 'GET') return returnToPreview(res, url, 'logout');

    const match = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
    const name = match && Object.hasOwn(providers, match[1]) ? match[1] : null;
    if (!name) fail(404, 'Not found.');
    const action = match[2];
    if (action === '/.well-known/openid-configuration' && req.method === 'GET') {
      const metadata = { ...(await discovery(name)),
        authorization_endpoint: `${base}/p/${name}/authorize`, token_endpoint: `${base}/p/${name}/token` };
      if (metadata.end_session_endpoint) metadata.end_session_endpoint = `${base}/p/${name}/logout`;
      const allowed = corsOrigin(req);
      if (allowed) { res.setHeader('Access-Control-Allow-Origin', allowed); res.setHeader('Vary', 'Origin'); }
      return json(res, 200, metadata);
    }
    if (action === '/authorize' && req.method === 'GET') return authorize(res, url, name);
    if (action === '/logout' && req.method === 'GET') return logout(res, url, name);
    if (action === '/token') return forwardForm(req, res, (await discovery(name)).token_endpoint, 'token');
    if (action === '/exchange' && providers[name].tokenExchange)
      return forwardForm(req, res, providers[name].tokenExchange, 'exchange');
    fail(404, 'Not found.');
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    let url;
    try { url = new URL(req.url, origin); } catch { /* Rejected below. */ }
    try {
      if (!url || req.headers.host !== origin.host || url.origin !== origin.origin) fail(400, 'Unexpected host or origin.');
      await route(req, res, url);
    } catch (error) {
      // Messages are fixed strings; no request value, code or token is echoed or logged.
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Relay error.' });
      else res.destroy();
    } finally {
      req.resume();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

// Serves the Trusted Let website, and signs agency staff in when they open it from Harbor Ops.
//
// Usage (Node 20.12+, no dependencies):
//   node server.mjs
//
// Public pages are served exactly as before. Staff who click the website's card on their Harbor Ops
// dashboard arrive at POST /harbor-sign-in with a signed token and get a session cookie. With it,
// GET /staff/listings.json returns the staff-only listing fields (landlord, paying flag, SpareRoom
// link) that scripts/fetch-listings.mjs writes to private/staff-listings.json; signed out it is a 401
// and the pages stay public.
//
// Settings come from the environment, falling back to .env in the site folder:
//   HARBOR_SIGN_IN_SECRET    the website secret from Harbor Ops (starts with hos_), exactly as shown
//   HARBOR_SIGN_IN_AUDIENCE  this site's origin, e.g. https://www.trustedlet.co.uk (no path or trailing /)
//   SESSION_SECRET           32+ random characters that sign the staff session cookie
//   PORT, HOST               default 3000 on 127.0.0.1: put Caddy or nginx in front for https
// Without the first three the public site still works and staff sign-in is off.
//
// Run ONE process: used sign-in tokens are remembered in memory, so several instances (PM2 cluster
// mode, say) would each accept the same token once.

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const LOCAL_ENV = join(ROOT, '.env');
if (existsSync(LOCAL_ENV)) process.loadEnvFile(LOCAL_ENV); // variables already set in the environment win

const SECRET = process.env.HARBOR_SIGN_IN_SECRET?.trim();
const AUDIENCE = process.env.HARBOR_SIGN_IN_AUDIENCE?.trim();
const SESSION_SECRET = process.env.SESSION_SECRET?.trim();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const HOME = '/Trusted%20Let.dc.html'; // the page runtime names a page after its URL, so / redirects here
const SIGN_IN_PATH = '/harbor-sign-in';
const STAFF_DATA_PATH = '/staff/listings.json';
const STAFF_FILE = join(ROOT, 'private', 'staff-listings.json');
const SIGN_IN_FAILED = 'This sign-in link has expired. Open the website again from Harbor Ops.';
const CLOCK_LEEWAY_S = 30;
const USED_TOKEN_MS = 5 * 60_000;
const SESSION_COOKIE = 'tls_staff';
const SESSION_S = 12 * 60 * 60; // a staff member removed in Harbor Ops keeps access until this runs out
const MAX_FORM_BYTES = 16 * 1024; // the form is one token of about 1 KB

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};
// Only files with a type above are served, and never from these folders or dotfiles (.env and friends).
const PRIVATE_DIRS = new Set(['private', 'scripts', 'deploy', 'vps', 'node_modules']);
const PUBLIC_DOTFILES = new Set(['.image-slots.state.json']); // image-slot.js reads it when present

const audienceOk = (() => { try { return new URL(AUDIENCE).origin === AUDIENCE; } catch { return false; } })();
const SIGN_IN_ON = !!SECRET && audienceOk && (SESSION_SECRET || '').length >= 32;

const usedTokens = new Map(); // jti -> expiry (ms); in memory, so one process only (see the top)

const nonEmpty = v => typeof v === 'string' && v.length > 0;
const hmac = (key, text) => createHmac('sha256', key).update(text).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function decodeJson(part) {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Checks a Harbor Ops sign-in token (an HS256 JWT). Returns { claims }, or { error } saying why it was
// refused, for the server log only: the visitor always gets the same message.
function verifyHarborToken(token) {
  if (!SIGN_IN_ON) return { error: 'sign-in is not configured' };
  if (!nonEmpty(token)) return { error: 'no token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { error: 'malformed token' };
  const [header, payload, signature] = parts;

  if (!safeEqual(signature, hmac(SECRET, `${header}.${payload}`))) return { error: 'bad signature' };
  const h = decodeJson(header), c = decodeJson(payload);
  if (!h || h.alg !== 'HS256') return { error: 'wrong algorithm' };
  if (!c) return { error: 'malformed claims' };
  if (c.iss !== 'harbor-ops') return { error: 'wrong issuer' };
  if (c.aud !== AUDIENCE) return { error: `audience ${JSON.stringify(c.aud)} is not ${AUDIENCE}` };
  if (typeof c.exp !== 'number' || c.exp + CLOCK_LEEWAY_S < Date.now() / 1000) return { error: 'expired' };
  if (!nonEmpty(c.sub) || !nonEmpty(c.email) || !nonEmpty(c.jti)) return { error: 'missing sub, email or jti' };

  // Each token works once.
  for (const [jti, until] of usedTokens) if (until < Date.now()) usedTokens.delete(jti);
  if (usedTokens.has(c.jti)) return { error: 'replayed' };
  usedTokens.set(c.jti, Date.now() + USED_TOKEN_MS);
  return { claims: c };
}

/** A path on this website to send the person to; anything off-site becomes "/". */
function safeReturnTo(returnTo) {
  try {
    const url = new URL(typeof returnTo === 'string' ? returnTo : '/', AUDIENCE);
    return url.origin === AUDIENCE ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

// The session is the signed cookie itself: { id, email, name, isAdmin, exp }. Signing in always issues a
// fresh one, and there is no server-side session id that could be fixed in advance.
function sessionCookie(staff) {
  const body = Buffer.from(JSON.stringify({ ...staff, exp: Math.floor(Date.now() / 1000) + SESSION_S })).toString('base64url');
  const secure = AUDIENCE.startsWith('https:') ? '; Secure' : ''; // plain http only for local testing
  return `${SESSION_COOKIE}=${body}.${hmac(SESSION_SECRET, body)}; Path=/; Max-Age=${SESSION_S}; HttpOnly; SameSite=Lax${secure}`;
}

function readSession(req) {
  if (!SIGN_IN_ON) return null;
  const raw = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(SESSION_COOKIE + '='));
  const [body, sig] = (raw || '').slice(SESSION_COOKIE.length + 1).split('.');
  if (!body || !sig || !safeEqual(sig, hmac(SESSION_SECRET, body))) return null;
  const s = decodeJson(body);
  return s && typeof s.exp === 'number' && s.exp > Date.now() / 1000 ? s : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers
  });
  res.end(body);
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_FORM_BYTES) return chunks.push(chunk);
      req.removeAllListeners('data').resume(); // too big to be from Harbor Ops: drain it and refuse
      resolve(null);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

// Harbor Ops makes the browser POST here cross-site with one form field, harbor_token. The signed token
// is the authentication, so there is no CSRF token to check; a GET never signs anyone in.
async function signIn(req, res) {
  if (req.method !== 'POST') return send(res, 405, 'Open this website from your Harbor Ops dashboard to sign in.', { Allow: 'POST' });
  const isForm = /^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] || '');
  const form = isForm ? await readForm(req) : null;
  const { claims, error } = form ? verifyHarborToken(form.get('harbor_token')) : { error: isForm ? 'form too large' : 'not a form post' };
  if (error) {
    console.warn(`harbor-sign-in: refused (${error})`);
    return send(res, 403, SIGN_IN_FAILED);
  }
  const staff = { id: claims.sub, email: claims.email, name: nonEmpty(claims.name) ? claims.name : null, isAdmin: claims.is_admin === true };
  console.log(`harbor-sign-in: ${staff.email} signed in`);
  // AUDIENCE + path, not new URL(path, AUDIENCE): a path like //elsewhere.com must stay on this site.
  res.writeHead(303, { Location: AUDIENCE + safeReturnTo(claims.return_to), 'Set-Cookie': sessionCookie(staff), 'Cache-Control': 'no-store' });
  res.end();
}

async function staffListings(req, res) {
  const staff = readSession(req);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
  if (!staff) return send(res, 401, JSON.stringify({ error: 'Not signed in' }), headers);
  let data;
  try {
    data = JSON.parse(await readFile(STAFF_FILE, 'utf8'));
  } catch (err) {
    console.error(`staff listings: ${err.message} (run node scripts/fetch-listings.mjs)`);
    return send(res, 503, JSON.stringify({ error: 'Staff details are unavailable' }), headers);
  }
  send(res, 200, JSON.stringify({ staff: { name: staff.name, email: staff.email }, ...data }), headers);
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  const parts = rel.split('/').filter(Boolean);
  const hidden = (p, i) => p.startsWith('.') && !(i === parts.length - 1 && PUBLIC_DOTFILES.has(p));
  const type = TYPES[extname(rel).toLowerCase()];
  if (!type || /[\\\0]/.test(rel) || parts.some(hidden) || PRIVATE_DIRS.has((parts[0] || '').toLowerCase())) {
    return send(res, 404, 'Not found');
  }
  const file = join(ROOT, ...parts);
  const info = await stat(file).catch(() => null);
  if (!file.startsWith(ROOT) || !info?.isFile()) return send(res, 404, 'Not found');

  const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

createServer(async (req, res) => {
  try {
    const pathname = req.url.split(/[?#]/)[0];
    if (pathname === SIGN_IN_PATH) return await signIn(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    if (pathname === '/') return send(res, 302, '', { Location: HOME });
    if (pathname === STAFF_DATA_PATH) return await staffListings(req, res);
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.destroy();
    else send(res, 500, 'Something went wrong. Please try again.');
  }
}).listen(PORT, HOST, () => {
  console.log(`Trusted Let website on http://${HOST}:${PORT}`);
  if (SIGN_IN_ON) console.log(`Harbor Ops sign-in on: Sign-in URL ${AUDIENCE}${SIGN_IN_PATH}`);
  else console.warn('Harbor Ops sign-in is OFF: set HARBOR_SIGN_IN_SECRET, HARBOR_SIGN_IN_AUDIENCE (an origin like https://www.example.co.uk) and SESSION_SECRET (32+ characters).');
});

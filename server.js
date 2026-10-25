// Private Zone — real, server-backed, multi-user social app.
// Dependency-free Node.js (built-ins only) so it runs with `node server.js`.
// IMPORTANT HONESTY NOTES (also in README.md and in the UI):
//  - Payouts are RECORDS ONLY until the owner completes Stripe Connect verification.
//    No real money is moved by this code.
//  - Premium checkout uses a payment link the OWNER creates in his own Stripe dashboard
//    (Muse Stripe writes are blocked). If STRIPE_PREMIUM_PAYMENT_LINK is empty, Premium
//    shows as "not configured yet" — no link is invented.
//  - Demo seed data is clearly flagged isDemo:true and demo accounts cannot log in.
//  - Production video calls need a TURN server for some networks (see README).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 10);
const STRIPE_PREMIUM_PAYMENT_LINK = process.env.STRIPE_PREMIUM_PAYMENT_LINK || '';
const STRIPE_PREMIUM_PRICE_ID = process.env.STRIPE_PREMIUM_PRICE_ID || '';
const TURN_URL = process.env.TURN_URL || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

if (!process.env.SESSION_SECRET) {
  console.warn('[Private Zone] WARNING: SESSION_SECRET is not set. Using a dev-only fallback. Set a long random SESSION_SECRET before going live.');
}

// ---------- persistence ----------
function uid() { return crypto.randomBytes(12).toString('hex'); }
function now() { return new Date().toISOString(); }

function seedData() {
  const maya = { id: 'demo-maya', name: 'Maya (Demo)', email: 'demo-maya@example.invalid', passwordHash: null, bio: 'Demo account — not a real user.', avatarColor: '#e91e63', isDemo: true, premium: false, createdAt: now() };
  const dre = { id: 'demo-dre', name: 'Dre (Demo)', email: 'demo-dre@example.invalid', passwordHash: null, bio: 'Demo account — not a real user.', avatarColor: '#2196f3', isDemo: true, premium: false, createdAt: now() };
  const sofia = { id: 'demo-sofia', name: 'Sofia (Demo)', email: 'demo-sofia@example.invalid', passwordHash: null, bio: 'Demo account — not a real user.', avatarColor: '#ff9800', isDemo: true, premium: false, createdAt: now() };
  return {
    users: [maya, dre, sofia],
    posts: [
      { id: uid(), userId: maya.id, text: 'Sunday dinner is live tonight! (Demo post)', imageUrl: '', videoUrl: '', createdAt: now(), isDemo: true },
      { id: uid(), userId: dre.id, text: 'Park hoops highlights — new clip up. (Demo post)', imageUrl: '', videoUrl: '', createdAt: now(), isDemo: true },
      { id: uid(), userId: sofia.id, text: 'Photo prints are back in the shop. (Demo post)', imageUrl: '', videoUrl: '', createdAt: now(), isDemo: true },
    ],
    likes: [], comments: [], saved: [], hidden: [], shares: [],
    reactions: [], pollVotes: [], events: [], rsvps: [], flashes: [],
    stories: [
      { id: uid(), userId: maya.id, text: 'Demo story: Sunday dinner prep', imageUrl: '', createdAt: now(), isDemo: true },
      { id: uid(), userId: dre.id, text: 'Demo story: courtside', imageUrl: '', createdAt: now(), isDemo: true },
    ],
    friends: [],
    messages: [],
    listings: [
      { id: uid(), userId: sofia.id, title: 'Demo: Photo print bundle', price: 25, description: 'Demo listing only — not for sale here.', createdAt: now(), isDemo: true },
    ],
    collabs: [],
    payouts: [],
    notifications: [],
    calls: [],
  };
}

let db;
try {
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const k of Object.keys(seedData())) if (!Array.isArray(db[k])) db[k] = [];
  } else {
    db = seedData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    console.log('[Private Zone] Seeded demo data (flagged isDemo) in', DATA_FILE);
  }
} catch (e) {
  console.error('[Private Zone] Failed to load data file, starting from seed:', e.message);
  db = seedData();
}
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('save failed', e.message); }
}

// ---------- auth helpers ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function checkPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}
function signToken(userId) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ userId, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let data; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (data.exp < Date.now()) return null;
  return db.users.find(u => u.id === data.userId) || null;
}
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, email, ...rest } = u;
  return { ...rest, email: undefined };
}
function notify(userId, type, text, relatedId) {
  db.notifications.push({ id: uid(), userId, type, text, relatedId: relatedId || null, read: false, createdAt: now() });
}
function areFriends(a, b) {
  return db.friends.some(f => f.status === 'accepted' && ((f.fromId === a && f.toId === b) || (f.fromId === b && f.toId === a)));
}
function chatIdFor(a, b) { return [a, b].sort().join('__'); }

// ---------- new features: reactions, polls, explore, events ----------
// Defensive: live DBs created before these collections existed may lack them.
const REACTION_EMOJIS = ['❤️', '😂', '🔥', '👍', '😮', '😢'];
function arr(name) { if (!Array.isArray(db[name])) db[name] = []; return db[name]; }
function reactionCounts(postId) {
  const counts = {};
  for (const r of arr('reactions').filter(x => x.postId === postId)) counts[r.emoji] = (counts[r.emoji] || 0) + 1;
  return counts;
}
function pollInfo(post, userId) {
  if (!Array.isArray(post.pollOptions) || !post.pollOptions.length) return null;
  const votes = arr('pollVotes').filter(v => v.postId === post.id);
  const total = votes.length;
  const mine = votes.find(v => v.userId === userId);
  return {
    options: post.pollOptions.map((text, optionIndex) => {
      const count = votes.filter(v => v.optionIndex === optionIndex).length;
      return { optionIndex, text, votes: count, percent: total ? Math.round(count * 100 / total) : 0 };
    }),
    totalVotes: total,
    myVote: mine ? mine.optionIndex : null,
  };
}
function enrichPost(post, userId) {
  const likes = db.likes.filter(l => l.postId === post.id).length;
  const comments = db.comments.filter(c => c.postId === post.id).map(c => ({ ...c, author: publicUser(db.users.find(x => x.id === c.userId)) }));
  const shares = db.shares.filter(s => s.postId === post.id).length;
  const mine = arr('reactions').find(r => r.postId === post.id && r.userId === userId);
  return {
    ...post,
    author: publicUser(db.users.find(x => x.id === post.userId)),
    likes,
    likedByMe: db.likes.some(l => l.postId === post.id && l.userId === userId),
    savedByMe: db.saved.some(s => s.postId === post.id && s.userId === userId),
    shares,
    comments,
    reactions: reactionCounts(post.id),
    myReaction: mine ? mine.emoji : null,
    poll: pollInfo(post, userId),
    engagement: likes + 2 * comments.length + shares,
  };
}

// ---------- Flashes: ephemeral, one-time messages ----------
// A Flash lives 24 hours and can be opened exactly once by its recipient.
// The inbox list never carries the content itself, so listing cannot leak it.
// After a successful view the content is cleared server-side, so a second
// view (or any later fetch) cannot return it again.
const FLASH_TTL_MS = 24 * 3600 * 1000;
function flashExpired(f) { return Date.now() - new Date(f.createdAt).getTime() > FLASH_TTL_MS; }
function flashExpiresAt(f) { return new Date(new Date(f.createdAt).getTime() + FLASH_TTL_MS).toISOString(); }
function flashMsLeft(f) { return Math.max(0, new Date(f.createdAt).getTime() + FLASH_TTL_MS - Date.now()); }

// ---------- http helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({ _parseError: true }); }
    });
  });
}
function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  return verifyToken(token);
}
function requireAuth(req, res) {
  const u = authUser(req);
  if (!u) { sendJson(res, 401, { error: 'Login required' }); return null; }
  return u;
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
function serveStatic(req, res) {
  let filePath = req.url === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, decodeURIComponent(req.url.split('?')[0]));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/health') return sendJson(res, 200, { ok: true, app: 'Private Zone', version: '1.0.0' });
  if (p === '/api/config') {
    return sendJson(res, 200, {
      platformFeePercent: PLATFORM_FEE_PERCENT,
      premiumConfigured: Boolean(STRIPE_PREMIUM_PAYMENT_LINK),
      premiumPaymentLink: STRIPE_PREMIUM_PAYMENT_LINK || null,
      premiumPriceId: STRIPE_PREMIUM_PRICE_ID || null,
      turnConfigured: Boolean(TURN_URL),
      payoutsAreRecordsOnly: true,
      payoutNote: 'Payouts are recorded only. No real money is sent until the owner completes Stripe Connect verification.',
    });
  }

  // Auth
  if (p === '/api/auth/signup' && method === 'POST') {
    const b = await readBody(req);
    if (b._parseError) return sendJson(res, 400, { error: 'Invalid JSON' });
    const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
    if (!name || !email || password.length < 6) return sendJson(res, 400, { error: 'Name, email and a password of at least 6 characters are required.' });
    if (db.users.some(u => u.email === email)) return sendJson(res, 400, { error: 'That email is already registered.' });
    const user = { id: uid(), name, email, passwordHash: hashPassword(password), bio: '', avatarColor: '#1877f2', isDemo: false, premium: false, createdAt: now() };
    db.users.push(user); save();
    return sendJson(res, 201, { user: publicUser(user), token: signToken(user.id) });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
    const user = db.users.find(u => u.email === email);
    if (!user || user.isDemo || !checkPassword(password, user.passwordHash)) return sendJson(res, 401, { error: 'Invalid email or password. Demo accounts cannot log in.' });
    return sendJson(res, 200, { user: publicUser(user), token: signToken(user.id) });
  }
  if (p === '/api/auth/me' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    return sendJson(res, 200, { user: publicUser(u) });
  }
  if (p === '/api/users' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const list = db.users.filter(x => !q || x.name.toLowerCase().includes(q)).map(publicUser);
    return sendJson(res, 200, { users: list });
  }
  const userMatch = p.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const found = db.users.find(x => x.id === userMatch[1]);
    if (!found) return sendJson(res, 404, { error: 'User not found' });
    return sendJson(res, 200, { user: publicUser(found) });
  }
  if (p === '/api/profile' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    if (b.bio !== undefined) u.bio = String(b.bio).slice(0, 500);
    if (b.name) u.name = String(b.name).slice(0, 100);
    save(); return sendJson(res, 200, { user: publicUser(u) });
  }

  // Posts
  if (p === '/api/posts' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const hiddenIds = new Set(db.hidden.filter(h => h.userId === u.id).map(h => h.postId));
    const posts = db.posts.filter(x => !hiddenIds.has(x.id)).slice().reverse().map(post => enrichPost(post, u.id));
    return sendJson(res, 200, { posts });
  }
  if (p === '/api/posts' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    if (!text && !b.imageUrl && !b.videoUrl) return sendJson(res, 400, { error: 'Post needs text, an image, or a video.' });
    let pollOptions = null;
    if (b.pollOptions !== undefined && b.pollOptions !== null) {
      if (!Array.isArray(b.pollOptions)) return sendJson(res, 400, { error: 'Poll options must be a list.' });
      pollOptions = b.pollOptions.map(x => String(x || '').trim()).filter(Boolean);
      if (pollOptions.length < 2 || pollOptions.length > 4) return sendJson(res, 400, { error: 'A poll needs 2 to 4 options.' });
    }
    const post = { id: uid(), userId: u.id, text, imageUrl: String(b.imageUrl || ''), videoUrl: String(b.videoUrl || ''), pollOptions, createdAt: now(), isDemo: false };
    db.posts.push(post); save();
    return sendJson(res, 201, { post: enrichPost(post, u.id) });
  }
  // Emoji reactions: one per user per post; same emoji again removes it, another switches it.
  const reactMatch = p.match(/^\/api\/posts\/([^/]+)\/react$/);
  if (reactMatch && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const post = db.posts.find(x => x.id === reactMatch[1]);
    if (!post) return sendJson(res, 404, { error: 'Post not found' });
    const b = await readBody(req);
    const emoji = String(b.emoji || '');
    if (!REACTION_EMOJIS.includes(emoji)) return sendJson(res, 400, { error: 'Emoji must be one of ❤️ 😂 🔥 👍 😮 😢.' });
    const reactions = arr('reactions');
    const i = reactions.findIndex(r => r.postId === post.id && r.userId === u.id);
    if (i >= 0 && reactions[i].emoji === emoji) reactions.splice(i, 1);
    else if (i >= 0) reactions[i].emoji = emoji;
    else reactions.push({ postId: post.id, userId: u.id, emoji });
    save();
    return sendJson(res, 200, { ok: true, post: enrichPost(post, u.id) });
  }
  // Poll votes: changeable.
  const voteMatch = p.match(/^\/api\/posts\/([^/]+)\/vote$/);
  if (voteMatch && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const post = db.posts.find(x => x.id === voteMatch[1]);
    if (!post) return sendJson(res, 404, { error: 'Post not found' });
    if (!Array.isArray(post.pollOptions) || !post.pollOptions.length) return sendJson(res, 400, { error: 'This post has no poll.' });
    const b = await readBody(req);
    const optionIndex = Number(b.optionIndex);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= post.pollOptions.length) return sendJson(res, 400, { error: 'Invalid poll option.' });
    const votes = arr('pollVotes');
    const i = votes.findIndex(v => v.postId === post.id && v.userId === u.id);
    if (i >= 0) votes[i].optionIndex = optionIndex;
    else votes.push({ postId: post.id, userId: u.id, optionIndex });
    save();
    return sendJson(res, 200, { ok: true, post: enrichPost(post, u.id) });
  }
  // Explore / Trending: engagement = likes + 2*comments + shares, highest first, hidden excluded.
  if (p === '/api/explore' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const hiddenIds = new Set(db.hidden.filter(h => h.userId === u.id).map(h => h.postId));
    const posts = db.posts.filter(x => !hiddenIds.has(x.id)).map(post => enrichPost(post, u.id))
      .sort((a, b) => (b.engagement - a.engagement) || (new Date(b.createdAt) - new Date(a.createdAt)));
    return sendJson(res, 200, { posts });
  }
  // Events with RSVP: one RSVP per user, changeable.
  if (p === '/api/events' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const rsvps = arr('rsvps');
    const events = arr('events').slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).map(e => {
      const mine = rsvps.find(r => r.eventId === e.id && r.userId === u.id);
      const counts = { going: 0, interested: 0, 'not-going': 0 };
      for (const r of rsvps.filter(x => x.eventId === e.id)) if (counts[r.status] !== undefined) counts[r.status]++;
      return { ...e, creator: publicUser(db.users.find(x => x.id === e.userId)), rsvpCounts: counts, myRsvp: mine ? mine.status : null };
    });
    return sendJson(res, 200, { events });
  }
  if (p === '/api/events' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    const title = String(b.title || '').trim(), date = String(b.date || '').trim();
    if (!title || !date) return sendJson(res, 400, { error: 'Event title and date are required.' });
    const event = { id: uid(), userId: u.id, title, date, location: String(b.location || ''), description: String(b.description || ''), createdAt: now(), isDemo: false };
    arr('events').push(event); save();
    return sendJson(res, 201, { event });
  }
  const rsvpMatch = p.match(/^\/api\/events\/([^/]+)\/rsvp$/);
  if (rsvpMatch && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const event = arr('events').find(x => x.id === rsvpMatch[1]);
    if (!event) return sendJson(res, 404, { error: 'Event not found' });
    const b = await readBody(req);
    const status = String(b.status || '');
    if (!['going', 'interested', 'not-going'].includes(status)) return sendJson(res, 400, { error: 'RSVP status must be going, interested, or not-going.' });
    const rsvps = arr('rsvps');
    const i = rsvps.findIndex(r => r.eventId === event.id && r.userId === u.id);
    if (i >= 0) rsvps[i].status = status;
    else rsvps.push({ eventId: event.id, userId: u.id, status });
    save();
    return sendJson(res, 200, { ok: true });
  }
  // Flashes
  if (p === '/api/flashes' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    const toId = String(b.toId || '');
    if (toId === u.id) return sendJson(res, 400, { error: 'You cannot send a Flash to yourself.' });
    const target = db.users.find(x => x.id === toId);
    if (!target) return sendJson(res, 404, { error: 'Recipient not found' });
    const text = String(b.text || '').trim(), imageUrl = String(b.imageUrl || ''), videoUrl = String(b.videoUrl || '');
    if (!text && !imageUrl && !videoUrl) return sendJson(res, 400, { error: 'A Flash needs text, an image, or a video.' });
    const flash = { id: uid(), fromId: u.id, toId, text, imageUrl, videoUrl, viewed: false, createdAt: now(), isDemo: false };
    arr('flashes').push(flash); save();
    if (!target.isDemo) notify(toId, 'flash', `${u.name} sent you a Flash.`, flash.id);
    return sendJson(res, 201, { flash: { id: flash.id, toId: flash.toId, createdAt: flash.createdAt, expiresAt: flashExpiresAt(flash) } });
  }
  if (p === '/api/flashes' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    // Summary only: no content, so the inbox list cannot leak a one-time Flash.
    const flashes = arr('flashes').filter(f => f.toId === u.id && !f.viewed && !flashExpired(f)).slice().reverse().map(f => ({
      id: f.id, sender: publicUser(db.users.find(x => x.id === f.fromId)), createdAt: f.createdAt,
      expiresAt: flashExpiresAt(f), msLeft: flashMsLeft(f),
      hasText: Boolean(f.text), hasImage: Boolean(f.imageUrl), hasVideo: Boolean(f.videoUrl),
    }));
    return sendJson(res, 200, { flashes });
  }
  if (p === '/api/flashes/sent' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const flashes = arr('flashes').filter(f => f.fromId === u.id).slice().reverse().map(f => {
      const viewed = Boolean(f.viewed), expired = flashExpired(f);
      return {
        id: f.id, recipient: publicUser(db.users.find(x => x.id === f.toId)), createdAt: f.createdAt,
        expiresAt: flashExpiresAt(f), viewed, expired,
        // Viewed (or expired) Flashes carry no re-openable content here.
        text: (!viewed && !expired) ? f.text : '', imageUrl: (!viewed && !expired) ? f.imageUrl : '', videoUrl: (!viewed && !expired) ? f.videoUrl : '',
      };
    });
    return sendJson(res, 200, { flashes });
  }
  const flashViewMatch = p.match(/^\/api\/flashes\/([^/]+)\/view$/);
  if (flashViewMatch && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const flash = arr('flashes').find(x => x.id === flashViewMatch[1]);
    if (!flash || flash.toId !== u.id) return sendJson(res, 404, { error: 'Flash not found' });
    if (flash.viewed) return sendJson(res, 410, { error: 'This Flash has already been viewed and is gone.' });
    if (flashExpired(flash)) return sendJson(res, 410, { error: 'This Flash has expired.' });
    const content = { id: flash.id, sender: publicUser(db.users.find(x => x.id === flash.fromId)), text: flash.text, imageUrl: flash.imageUrl, videoUrl: flash.videoUrl, createdAt: flash.createdAt };
    // Clear content server-side immediately, so it can never be returned again.
    flash.viewed = true; flash.text = ''; flash.imageUrl = ''; flash.videoUrl = ''; save();
    return sendJson(res, 200, { flash: content });
  }
  const postAction = p.match(/^\/api\/posts\/([^/]+)\/(like|comment|share|save|hide)$/);
  if (postAction && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const post = db.posts.find(x => x.id === postAction[1]);
    if (!post) return sendJson(res, 404, { error: 'Post not found' });
    const action = postAction[2]; const b = await readBody(req);
    if (action === 'like') {
      const i = db.likes.findIndex(l => l.postId === post.id && l.userId === u.id);
      if (i >= 0) db.likes.splice(i, 1); else db.likes.push({ postId: post.id, userId: u.id });
    } else if (action === 'comment') {
      const text = String(b.text || '').trim(); if (!text) return sendJson(res, 400, { error: 'Comment text required' });
      db.comments.push({ id: uid(), postId: post.id, userId: u.id, text, createdAt: now() });
      if (post.userId !== u.id) notify(post.userId, 'comment', `${u.name} commented on your post.`, post.id);
    } else if (action === 'share') {
      db.shares.push({ postId: post.id, userId: u.id });
    } else if (action === 'save') {
      const i = db.saved.findIndex(s => s.postId === post.id && s.userId === u.id);
      if (i >= 0) db.saved.splice(i, 1); else db.saved.push({ postId: post.id, userId: u.id });
    } else if (action === 'hide') {
      if (!db.hidden.some(h => h.postId === post.id && h.userId === u.id)) db.hidden.push({ postId: post.id, userId: u.id });
    }
    save(); return sendJson(res, 200, { ok: true });
  }
  // Stories
  if (p === '/api/stories' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    return sendJson(res, 200, { stories: db.stories.slice().reverse().map(s => ({ ...s, author: publicUser(db.users.find(x => x.id === s.userId)) })) });
  }
  if (p === '/api/stories' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    const story = { id: uid(), userId: u.id, text: String(b.text || '').trim(), imageUrl: String(b.imageUrl || ''), createdAt: now(), isDemo: false };
    db.stories.push(story); save(); return sendJson(res, 201, { story });
  }
  // Friends
  if (p === '/api/friends' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const mine = db.friends.filter(f => f.fromId === u.id || f.toId === u.id).map(f => ({
      ...f, other: publicUser(db.users.find(x => x.id === (f.fromId === u.id ? f.toId : f.fromId))),
    }));
    return sendJson(res, 200, { friends: mine });
  }
  if (p === '/api/friends/request' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    const toId = String(b.toId || '');
    if (toId === u.id) return sendJson(res, 400, { error: 'You cannot friend yourself.' });
    const target = db.users.find(x => x.id === toId);
    if (!target) return sendJson(res, 404, { error: 'User not found' });
    if (db.friends.some(f => (f.fromId === u.id && f.toId === toId) || (f.fromId === toId && f.toId === u.id))) return sendJson(res, 400, { error: 'Friend request already exists.' });
    db.friends.push({ fromId: u.id, toId, status: 'pending', createdAt: now() }); save();
    if (!target.isDemo) notify(toId, 'friend_request', `${u.name} sent you a friend request.`, u.id);
    return sendJson(res, 201, { ok: true });
  }
  if ((p === '/api/friends/accept' || p === '/api/friends/decline') && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    const f = db.friends.find(x => x.fromId === String(b.fromId || '') && x.toId === u.id && x.status === 'pending');
    if (!f) return sendJson(res, 404, { error: 'Pending request not found' });
    if (p.endsWith('/accept')) { f.status = 'accepted'; notify(f.fromId, 'friend_accepted', `${u.name} accepted your friend request.`, u.id); }
    else db.friends.splice(db.friends.indexOf(f), 1);
    save(); return sendJson(res, 200, { ok: true });
  }
  // Notifications
  if (p === '/api/notifications' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    return sendJson(res, 200, { notifications: db.notifications.filter(n => n.userId === u.id).slice().reverse() });
  }
  if (p === '/api/notifications/read-all' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    db.notifications.filter(n => n.userId === u.id).forEach(n => n.read = true); save();
    return sendJson(res, 200, { ok: true });
  }
  // Chats
  if (p === '/api/chats' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const peers = new Map();
    db.messages.filter(m => m.chatId === chatIdFor(u.id, m.fromId) || db.messages.some(() => false)).forEach(() => {});
    // Build peer list from messages where I am sender or recipient (chatId encodes both ids)
    db.messages.forEach(m => {
      const parts = m.chatId.split('__');
      if (!parts.includes(u.id)) return;
      const peerId = parts.find(x => x !== u.id);
      const cur = peers.get(peerId);
      if (!cur || m.createdAt > cur.createdAt) peers.set(peerId, m);
    });
    // Also include accepted friends with no messages yet
    db.friends.filter(f => f.status === 'accepted').forEach(f => {
      const peerId = f.fromId === u.id ? f.toId : f.fromId;
      if (peerId !== u.id && !peers.has(peerId)) peers.set(peerId, null);
    });
    const chats = [...peers.entries()].map(([peerId, last]) => ({ peer: publicUser(db.users.find(x => x.id === peerId)), lastMessage: last }));
    return sendJson(res, 200, { chats });
  }
  const chatMatch = p.match(/^\/api\/chats\/([^/]+)$/);
  if (chatMatch && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const peerId = chatMatch[1];
    const msgs = db.messages.filter(m => m.chatId === chatIdFor(u.id, peerId)).map(m => ({ ...m, author: publicUser(db.users.find(x => x.id === m.fromId)) }));
    return sendJson(res, 200, { messages: msgs, peer: publicUser(db.users.find(x => x.id === peerId)) });
  }
  if (chatMatch && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    const text = String(b.text || '').trim(); if (!text) return sendJson(res, 400, { error: 'Message text required' });
    const peerId = chatMatch[1];
    const msg = { id: uid(), chatId: chatIdFor(u.id, peerId), fromId: u.id, text, type: 'text', createdAt: now() };
    db.messages.push(msg); save();
    const peer = db.users.find(x => x.id === peerId);
    if (peer && !peer.isDemo) notify(peerId, 'message', `${u.name} sent you a message.`, u.id);
    return sendJson(res, 201, { message: msg });
  }
  // Marketplace + Watch
  if (p === '/api/marketplace' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    return sendJson(res, 200, { listings: db.listings.slice().reverse().map(l => ({ ...l, seller: publicUser(db.users.find(x => x.id === l.userId)) })) });
  }
  if (p === '/api/marketplace' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    if (!b.title) return sendJson(res, 400, { error: 'Title required' });
    const listing = { id: uid(), userId: u.id, title: String(b.title), price: Number(b.price || 0), description: String(b.description || ''), createdAt: now(), isDemo: false };
    db.listings.push(listing); save(); return sendJson(res, 201, { listing });
  }
  if (p === '/api/watch' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const videos = db.posts.filter(x => x.videoUrl).slice().reverse().map(x => ({ ...x, author: publicUser(db.users.find(y => y.id === x.userId)) }));
    return sendJson(res, 200, { videos });
  }
  // Earn together
  if (p === '/api/earn/collabs' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const mine = db.collabs.filter(c => c.ownerId === u.id || c.members.some(m => m.userId === u.id)).map(c => ({
      ...c, memberDetails: c.members.map(m => ({ ...m, user: publicUser(db.users.find(x => x.id === m.userId)) })),
    }));
    return sendJson(res, 200, { collabs: mine });
  }
  if (p === '/api/earn/collabs' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    const members = Array.isArray(b.members) ? b.members : [];
    const sources = Array.isArray(b.sources) ? b.sources : [];
    if (!name || members.length === 0) return sendJson(res, 400, { error: 'Collab name and at least one member are required.' });
    const totalSplit = members.reduce((s, m) => s + Number(m.splitPercent || 0), 0);
    if (Math.abs(totalSplit - 100) > 0.01) return sendJson(res, 400, { error: `Member splits must add to 100 (got ${totalSplit}).` });
    for (const m of members) if (!db.users.find(x => x.id === m.userId)) return sendJson(res, 404, { error: 'A member user was not found.' });
    const collab = { id: uid(), ownerId: u.id, name, members: members.map(m => ({ userId: m.userId, splitPercent: Number(m.splitPercent) })), sources: sources.map(s => ({ name: String(s.name || 'Source'), amount: Number(s.amount || 0) })), createdAt: now() };
    db.collabs.push(collab); save();
    collab.members.filter(m => m.userId !== u.id).forEach(m => { const mem = db.users.find(x => x.id === m.userId); if (mem && !mem.isDemo) notify(m.userId, 'collab', `${u.name} invited you to Earn collab "${name}".`, collab.id); });
    return sendJson(res, 201, { collab });
  }
  const cashoutMatch = p.match(/^\/api\/earn\/collabs\/([^/]+)\/cashout$/);
  if (cashoutMatch && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const collab = db.collabs.find(c => c.id === cashoutMatch[1]);
    if (!collab) return sendJson(res, 404, { error: 'Collab not found' });
    if (collab.ownerId !== u.id && !collab.members.some(m => m.userId === u.id)) return sendJson(res, 403, { error: 'Not a member of this collab' });
    const pot = collab.sources.reduce((s, x) => s + Number(x.amount || 0), 0);
    const platformFee = Math.round(pot * PLATFORM_FEE_PERCENT / 100 * 100) / 100;
    const distributable = Math.round((pot - platformFee) * 100) / 100;
    const shares = collab.members.map(m => ({ userId: m.userId, percent: m.splitPercent, amount: Math.round(distributable * m.splitPercent / 100 * 100) / 100 }));
    const payout = { id: uid(), collabId: collab.id, collabName: collab.name, pot, platformFeePercent: PLATFORM_FEE_PERCENT, platformFee, distributable, shares, status: 'record-only', note: 'Record only — no real money was sent. Real payouts require Stripe Connect verification.', createdAt: now() };
    db.payouts.push(payout); save();
    shares.forEach(s => { const mem = db.users.find(x => x.id === s.userId); if (mem && !mem.isDemo && s.userId !== u.id) notify(s.userId, 'payout', `Earn payout recorded for "${collab.name}": $${s.amount.toFixed(2)} (record only).`, payout.id); });
    return sendJson(res, 201, { payout });
  }
  if (p === '/api/earn/payouts' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const mine = db.payouts.filter(x => x.shares.some(s => s.userId === u.id)).slice().reverse();
    return sendJson(res, 200, { payouts: mine });
  }
  // Video calls — signaling over HTTP polling (Socket.io-style rooms, no external dep).
  // The browser does the actual WebRTC media; the server only relays signaling messages.
  if (p === '/api/calls' && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const b = await readBody(req);
    const calleeId = String(b.calleeId || '');
    const callee = db.users.find(x => x.id === calleeId);
    if (!callee) return sendJson(res, 404, { error: 'Callee not found' });
    const call = { id: uid(), callerId: u.id, calleeId, status: 'ringing', createdAt: now(), endedAt: null, durationSec: null, signals: [] };
    db.calls.push(call); save();
    if (!callee.isDemo) notify(calleeId, 'call', `${u.name} is calling you.`, call.id);
    return sendJson(res, 201, { call });
  }
  if (p === '/api/calls/incoming' && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const incoming = db.calls.filter(c => c.calleeId === u.id && c.status === 'ringing').map(c => ({ ...c, caller: publicUser(db.users.find(x => x.id === c.callerId)) }));
    return sendJson(res, 200, { calls: incoming });
  }
  const callMatch = p.match(/^\/api\/calls\/([^/]+)$/);
  if (callMatch && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const call = db.calls.find(c => c.id === callMatch[1]);
    if (!call || (call.callerId !== u.id && call.calleeId !== u.id)) return sendJson(res, 404, { error: 'Call not found' });
    return sendJson(res, 200, { call: { ...call, caller: publicUser(db.users.find(x => x.id === call.callerId)), callee: publicUser(db.users.find(x => x.id === call.calleeId)) } });
  }
  const signalMatch = p.match(/^\/api\/calls\/([^/]+)\/signal$/);
  if (signalMatch && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const call = db.calls.find(c => c.id === signalMatch[1]);
    if (!call || (call.callerId !== u.id && call.calleeId !== u.id)) return sendJson(res, 404, { error: 'Call not found' });
    const b = await readBody(req);
    if (b.type === 'accept') call.status = 'active';
    call.signals.push({ fromId: u.id, type: String(b.type || ''), payload: b.payload || null, createdAt: now() });
    save(); return sendJson(res, 200, { ok: true, status: call.status });
  }
  if (signalMatch && method === 'GET') {
    const u = requireAuth(req, res); if (!u) return;
    const call = db.calls.find(c => c.id === signalMatch[1]);
    if (!call || (call.callerId !== u.id && call.calleeId !== u.id)) return sendJson(res, 404, { error: 'Call not found' });
    const since = Number(url.searchParams.get('since') || 0);
    const signals = call.signals.map((s, i) => ({ ...s, index: i })).filter(s => s.index > since && s.fromId !== u.id);
    return sendJson(res, 200, { signals, status: call.status });
  }
  const endMatch = p.match(/^\/api\/calls\/([^/]+)\/end$/);
  if (endMatch && method === 'POST') {
    const u = requireAuth(req, res); if (!u) return;
    const call = db.calls.find(c => c.id === endMatch[1]);
    if (!call || (call.callerId !== u.id && call.calleeId !== u.id)) return sendJson(res, 404, { error: 'Call not found' });
    const durationSec = Math.max(0, Math.round((Date.now() - new Date(call.createdAt).getTime()) / 1000));
    call.status = 'ended'; call.endedAt = now(); call.durationSec = durationSec;
    const peerId = call.callerId === u.id ? call.calleeId : call.callerId;
    db.messages.push({ id: uid(), chatId: chatIdFor(call.callerId, call.calleeId), fromId: u.id, text: `Video call · ${durationSec}s`, type: 'call', createdAt: now() });
    save(); return sendJson(res, 200, { call, peerId });
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown API route' });
  return serveStatic(req, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error('request error', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
  });
});
server.listen(PORT, () => {
  console.log(`[Private Zone] Listening on http://localhost:${PORT}`);
  console.log(`[Private Zone] Data file: ${DATA_FILE} | Platform fee (math only): ${PLATFORM_FEE_PERCENT}% | Premium configured: ${Boolean(STRIPE_PREMIUM_PAYMENT_LINK)} | TURN configured: ${Boolean(TURN_URL)}`);
});

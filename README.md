# Private Zone — Real, Live, Multi-User Social App

**This is a codebase, not a Muse artifact.** It was built this way on purpose:

- A Muse **static** page saves nothing between visitors and each visitor runs it alone.
- A Muse **fullstack** app is private to its owner only — friends cannot join it.
- This codebase is the public version: real signup/login, a real server, real friends,
  real chats, real video-call signaling, and Earn collabs with real split math.

Nothing here is deployed or published by building it. Deployment is a separate,
owner-approved step (see “Going live” below).

## What is real, and what is not — read this first

### Real
- **Accounts:** signup/login with scrypt-hashed passwords and HMAC-signed session tokens.
  Demo seed accounts are flagged `isDemo` and **cannot log in**.
- **Feed, stories, friends, chats, notifications, Watch, Marketplace:** server-backed,
  persisted to `data.json` (see “Data storage” for production notes).
- **Video calls:** 1-to-1 WebRTC in the browser. This server relays signaling
  (offer / answer / ICE candidates, call invite, accept, end) over HTTP polling —
  the same job Socket.io rooms do, without an extra dependency. Mute / camera /
  speaker / end controls work, and ending a call writes a call log entry into the chat.
- **Earn together split math:** a collab's pot, the platform fee, the distributable
  amount, and each member's share are computed on the server and recorded.
- **Owner profit — configurable, not invented:**
  1. **Premium subscription** via a Stripe payment link supplied through
     `STRIPE_PREMIUM_PAYMENT_LINK`. If it is empty, the app shows
     “Premium (not configured yet)” and does **not** invent a link.
  2. **Platform fee on Earn collabs**, default **10%** (`PLATFORM_FEE_PERCENT`),
     shown in the split math. This fee is **math only** until Stripe Connect is set up —
     it is not charged, held, or moved as real money by this code.
  3. **Ad slot:** a clearly labeled placeholder in the UI. No ad network is connected
     until the owner adds one (`AD_SLOT_ID`).

## Premium — what is real, and how granting works

Premium is **server-enforced**, not just a label:

- **⭐ Premium badge:** `publicUser()` includes `premium: true/false`, and the UI
  shows a ⭐ Premium badge next to Premium users' names on posts, profiles,
  friend lists, stories, Marketplace, Watch, Events, and Flashes.
- **Ad-free for Premium:** after login, the UI hides every `.ad-slot`
  (top banner and in-feed card) when `me.premium` is true. Free users still
  see the placeholder ad slots.
- **Custom profile accent:** Premium users can set `accentColor` via
  `POST /api/profile` — one of `orange, gold, cyan, pink, purple, green`
  only. Free users get a 400 if they try. The accent shows as a coloured
  left border and badge on that user's posts and profile.
- **Longer bio:** free bios are limited to **500** characters, Premium bios
  to **1,000** characters. Over-limit bios are rejected with a 400 by the
  server (not silently trimmed).
- **Explore boost:** Premium authors' posts get a **+2 boost** to their
  Explore ranking score (`likes + 2 × comments + shares + 2 if Premium`).
  The plain feed is not boosted, and the boost is shown on Explore posts —
  it is documented here and in the Explore/Premium views, not hidden.
- **Premium view:** the ⭐ Premium button now opens a Premium view (instead
  of only opening the payment link). It lists the perks above, shows the
  current user's status (Free / Premium), shows **“Checkout not configured
  yet”** honestly when `STRIPE_PREMIUM_PAYMENT_LINK` is empty, and opens
  the payment link in a new tab when it is configured. **No price is shown
  in the app** — there is no price amount in this codebase, and the view
  says only that the price, if any, is set by the owner in Stripe.

### Manual Premium granting (no webhook yet)

There is still **no Stripe webhook**. After a user pays through your Stripe
payment link, confirm the payment in your Stripe dashboard, then grant
Premium manually with the owner-only endpoint below. A real Stripe webhook
that verifies the Stripe signature and flips `premium: true` for the paying
user is still the recommended follow-up.

Set this env var on the host (a long random string you generate yourself):

```
PREMIUM_ADMIN_KEY=your-own-long-random-key
```

Grant Premium for a user by email:

```bash
curl -X POST https://YOUR_APP_URL/api/admin/premium/grant \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Key: your-own-long-random-key' \
  -d '{"email":"user@example.com"}'
```

Rules: if `PREMIUM_ADMIN_KEY` is empty, the endpoint always returns 403
rather than allowing open grants. A wrong or missing `X-Admin-Key` also
returns 403. An unknown email returns 404. A successful grant returns the
updated public user with `premium: true`. The user must log in again (or
refresh their session) for the badge, ad-free feed, and accent to appear.
**Never put `PREMIUM_ADMIN_KEY` in the frontend or in a committed file.**

Payouts remain record-only until Stripe Connect verification is complete,
even for Premium users — Premium does not change Earn payout behaviour,
and the Earn platform-fee math is unchanged.

### NOT real yet (placeholders / records only)
- **Payouts are records only.** Cashing out an Earn collab creates a payout record
  with each person's share. **No real money is sent.** Real payouts require the owner
  to complete **Stripe Connect verification** and then wire payouts (see “Going live”).
- **Premium is not auto-granted after payment.** There is no Stripe webhook in this
  codebase yet. If a user pays through your Stripe link, you must confirm the payment
  in Stripe and mark them Premium (a webhook is the recommended next step — see below).
- **Video on some networks needs a TURN server.** WebRTC uses a public STUN server
  by default. Behind symmetric NATs / strict corporate networks, calls may fail
  without TURN. Set `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` from a TURN
  provider you choose, and extend `/api/config` to return them to the browser
  (the server already reads those env vars; wiring them into the client ICE config
  is a small, documented follow-up).
- **Demo data is demo.** Seed users (Maya, Dre, Sofia), their posts, stories, and one
  listing are labeled `DEMO` in the UI and in the data (`isDemo: true`). They are
  separate from real user accounts. Delete them in production by clearing `data.json`
  and letting the server re-seed, then removing demo rows — or start with an empty
  data file (see “Data storage”).

## Run it locally — one command

Requirements: Node.js 18+ (tested on Node 24). No dependencies, no `npm install` needed.

```bash
cd private-zone-live
cp .env.example .env
# Edit .env: set SESSION_SECRET to a long random string.
# Leave STRIPE_PREMIUM_PAYMENT_LINK empty until you create your own link.
node server.js
```

Then open **http://localhost:3000**

Or, with npm:

```bash
npm start
```

You should see:

```
[Private Zone] Listening on http://localhost:3000
```

### Try the full loop (verified flow)
1. Sign up as Alice, then in another browser/incognito window sign up as Bob.
2. As Alice: search for Bob → Add friend. As Bob: Friends → Accept.
3. As Alice: post to the feed. As Bob: like / comment on it.
4. As Alice: Earn → pick Bob, set splits that add to 100 (e.g. 60 / 40),
   add a source (e.g. “Sunday Dinner Live — $100”), create the collab.
5. Cash out: pot $100, platform fee 10% = $10, distributable $90,
   Alice $54, Bob $36 — recorded as a payout record only.
6. Chat: message Bob, then start a video call from the chat header
   (browser will ask for camera/mic permission).

## Project layout

```
private-zone-live/
├── server.js            # Dependency-free Node server: API + static files + persistence
├── package.json         # `npm start` → node server.js (no dependencies)
├── .env.example         # Every secret/config as an env var — no real keys shipped
├── .gitignore           # Ignores .env, data.json, node_modules
├── data.json            # Created on first run: server data (git-ignored)
├── public/
│   ├── index.html       # Feed, Friends, Chats, Earn, Marketplace, Watch, Profile, call modal
│   ├── app.js           # Frontend logic + WebRTC call flow + signaling polling
│   └── styles.css
└── README.md            # This file
```

## API overview (all JSON, auth via `Authorization: Bearer <token>`)

| Area | Endpoints |
|---|---|
| Health / config | `GET /api/health`, `GET /api/config` |
| Auth | `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/profile` |
| Users / friends | `GET /api/users?q=`, `GET /api/users/:id`, `GET /api/friends`, `POST /api/friends/request`, `POST /api/friends/accept`, `POST /api/friends/decline` |
| Posts | `GET /api/posts`, `POST /api/posts`, `POST /api/posts/:id/like|comment|share|save|hide` |
| Stories | `GET /api/stories`, `POST /api/stories` |
| Chats | `GET /api/chats`, `GET /api/chats/:peerId`, `POST /api/chats/:peerId` |
| Marketplace / Watch | `GET+POST /api/marketplace`, `GET /api/watch` |
| Notifications | `GET /api/notifications`, `POST /api/notifications/read-all` |
| Earn | `GET+POST /api/earn/collabs`, `POST /api/earn/collabs/:id/cashout`, `GET /api/earn/payouts` |
| Video calls | `POST /api/calls`, `GET /api/calls/incoming`, `GET /api/calls/:id`, `POST /api/calls/:id/signal`, `GET /api/calls/:id/signal?since=N`, `POST /api/calls/:id/end` |
| Premium / admin | `GET /api/config` (includes `currentUserPremium` when called with a Bearer token), `POST /api/admin/premium/grant` (header `X-Admin-Key: PREMIUM_ADMIN_KEY`) |

### Earn split math (worked example)
- Sources total: **$100**
- Platform fee: **10% → $10** (configurable, math only until Stripe Connect)
- Distributable: **$90**
- Splits 60 / 40 → **Alice $54, Bob $36**
- A payout record is saved with exactly those numbers, plus the note that no real
  money was sent. The UI shows the same “record only” wording.

## Data storage

- Default storage is a JSON file (`DATA_FILE`, default `./data.json`) written on every
  mutation. That is fine for local testing and a small launch.
- **Before a real launch, move to a real database** (e.g. Postgres on your host).
  The data layer in `server.js` is intentionally small and centralized (`db`, `save()`)
  so swapping it for Postgres is a contained change — do not scale the JSON file
  to thousands of users.
- Back up `data.json` before deploying a new version, and never commit it or `.env`.

## Going live — step by step (owner must do these himself)

**Do not skip these. Nothing in this repo deploys itself, and no payment link,
key, or payout is invented for you.**

### 1. Get a host account (example: Render or Railway)
1. Create an account on Render (render.com) or Railway (railway.app).
2. Create a new **Web Service** from this repo/folder (push it to your own Git repo first).
3. Build command: none needed (no dependencies). Start command: `node server.js`.
4. Set the host's port handling: the server already reads `PORT` from the environment,
   which Render/Railway set automatically.
5. Set these environment variables on the host:
   - `SESSION_SECRET` — a long random string you generate yourself.
   - `PLATFORM_FEE_PERCENT` — e.g. `10`.
   - `STRIPE_PREMIUM_PAYMENT_LINK` — only after step 2 below; leave empty until then.
   - `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` — only if you add a TURN provider.

### 2. Premium checkout — you create the link (Muse Stripe writes are blocked)
1. Sign in to **your own Stripe dashboard** (the owner already has a Stripe account
   from the influencer store work; use that account or a new one — your choice).
2. Create a Premium product/price in Stripe, then create a **payment link** for it.
3. Copy **your** payment link into `STRIPE_PREMIUM_PAYMENT_LINK` on the host.
4. Test it yourself with a test payment before telling users about Premium.
5. Remember: payment does **not** auto-grant Premium in this codebase yet.
   Recommended next step: add a Stripe webhook endpoint that verifies the Stripe
   signature and flips `premium: true` for the paying user. Until then, confirm
   payments in Stripe and grant Premium manually.

### 3. Real Earn payouts — Stripe Connect verification (required before any real payout)
1. In Stripe, set up **Connect** and complete identity/business verification.
2. Onboard each Earn collaborator as a Connect account (or use Connect payouts
   to their bank, per Stripe's current flow).
3. Only then wire the payout record step to actually create Stripe transfers.
   Until that verification is complete, keep the app's “record only” wording —
   do not tell users money has been sent when it has not.

### 4. Video calls in production
1. Test a call between two real devices on different networks (not just localhost).
2. If calls fail on some networks, add a TURN provider (e.g. Twilio STUN/TURN,
   Metered, or a self-hosted coturn) and wire its credentials through env vars
   into the browser ICE servers.
3. Video calls require HTTPS in browsers (camera/mic permission). Your host
   (Render/Railway) provides HTTPS by default — do not serve the live app over plain HTTP.

### 5. Launch checklist
- [ ] `SESSION_SECRET` set to a long random value on the host (not the dev fallback).
- [ ] HTTPS on (host default).
- [ ] Demo data removed or clearly kept as demo only.
- [ ] Premium link tested by you, or Premium left as “not configured yet.”
- [ ] Payout copy still says “record only” until Stripe Connect is verified.
- [ ] Backups for the database / data file in place.
- [ ] Privacy / terms page added before charging anyone (not included in this build).

## What was verified in this build
- `node --check` passes for `server.js` and `public/app.js`.
- Server starts and answers `/api/health` and `/api/config`.
- Signup → login → post → friend request → accept → Earn collab → cash-out math
  was exercised end-to-end against the running server (see the test log in the
  delivery report; the exact numbers are in the “Earn split math” example above).
- Video-call signaling endpoints (create → signal → end → chat call-log) were
  exercised via the API; full browser WebRTC media (camera/mic) requires two real
  browsers and HTTPS/localhost permission, so it is verified at the signaling level
  here, not as a live two-device media call.

## Security notes
- Passwords: scrypt with a per-user salt. Never log or return password hashes.
- Tokens: HMAC-SHA256, 7-day expiry. Rotate `SESSION_SECRET` if it ever leaks
  (all existing tokens stop working — users will need to log in again).
- This build has no rate limiting, email verification, or content moderation.
  Add those before a public launch with real users.

# financezro — personal multi-bank dashboard

See all your accounts (Commerzbank, C24, Klarna, Advanzia, Revolut, PayPal, ...)
in one place. Runs on Cloudflare Workers + D1, using the **GoCardless Bank
Account Data** API — an official PSD2 Open Banking aggregator that covers
2,000+ European banks and payment providers, including neobanks and e-money
accounts.

## How it works (and why it's safe)

- You never enter your bank password into this app. Clicking "Connect" on a
  bank redirects your browser to **that bank's own login page** (or app).
  You approve read-only access there; GoCardless hands this app back only an
  account identifier and a short-lived, revocable, **read-only** access
  token — never your credentials.
- This app cannot move money. Only balances/transactions are requested
  (`access_scope: balances, details, transactions`), never payment
  initiation.
- The only long-lived secret this app stores is its own GoCardless API
  credential (`GC_SECRET_ID`/`GC_SECRET_KEY`), kept as a Cloudflare Worker
  **secret** (encrypted at rest, never in code or git).
- The dashboard itself is behind a password + session cookie
  (`APP_PASSWORD`) so a random visitor to your `*.workers.dev` URL can't see
  your data.
- If this app were ever compromised, the worst case is an attacker reading
  your linked accounts' balances/transactions until you revoke access (in
  your GoCardless dashboard or by removing the connection) — not access to
  move funds or your actual bank login.

## One-time setup

### 1. Get a free GoCardless Bank Account Data account
Sign up at <https://bankaccountdata.gocardless.com/> (free tier covers a
generous number of bank connections/month — enough for one person's
accounts). Go to **User secrets** and generate a `secret_id` + `secret_key`.

### 2. Install dependencies
```
npm install
```

### 3. Log in to Cloudflare (one-time, interactive)
```
npx wrangler login
```

### 4. Run the database migration (D1 + KV are already provisioned)
```
npm run migrate:remote
```

### 5. Set secrets
```
npx wrangler secret put GC_SECRET_ID
npx wrangler secret put GC_SECRET_KEY
npx wrangler secret put APP_PASSWORD   # the password you'll use to unlock the dashboard
```

### 6. Deploy
```
npm run deploy
```
Wrangler prints your live URL, e.g. `https://financezro.<your-subdomain>.workers.dev`.

### 7. Fix the redirect URL and redeploy
Open `wrangler.toml` and set `APP_REDIRECT_URL` to
`https://financezro.<your-subdomain>.workers.dev/api/callback` using the real
URL from step 6, then:
```
npm run deploy
```
(This has to be a real, reachable HTTPS URL — GoCardless redirects your
browser back to it after you approve access at your bank.)

## Using it

1. Open your `workers.dev` URL, enter your `APP_PASSWORD`.
2. Click **+ Add bank**, set the country code (e.g. `DE`), search for your
   bank by name (Commerzbank, C24, Klarna, Advanzia, Revolut, PayPal, ...),
   click **Connect**.
3. You're redirected to the bank's own login — approve access there.
4. You land back on the dashboard with that account's balance and
   transactions synced in.
5. Click **Refresh** any time to pull latest balances/transactions for all
   linked accounts. (GoCardless's free tier rate-limits requests per
   account per day — a few refreshes a day is fine, don't script it to
   poll continuously.)

## Notes / limitations

- **PayPal & some e-money accounts**: coverage depends on whether that
  provider currently participates in your country's Open Banking directory
  under GoCardless. If a bank doesn't show up in search, it may not (yet)
  be integrated by GoCardless — check their institution list for your
  country.
- **Access expiry**: bank consent (`access_valid_for_days`, currently 90)
  expires and needs periodic re-approval — that's a PSD2 requirement, not a
  bug, and it's the same "reconfirm access" flow you'd see in a banking app.
- This is built for **one user** (you) — there's no multi-user auth model,
  by design, to keep the attack surface small.

## Project layout

```
src/index.ts        Hono app: routes, auth middleware
src/gocardless.ts    GoCardless Bank Account Data API client
src/db.ts            D1 query helpers
src/auth.ts          Password + session cookie auth
public/index.html    Dashboard frontend (vanilla JS)
migrations/          D1 schema
```

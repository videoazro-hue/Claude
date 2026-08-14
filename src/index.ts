import { Hono } from "hono";
import type { Env } from "./types";
import * as gc from "./gocardless";
import * as db from "./db";
import { loginAdmin, loginUser, logout, getSession, isAuthenticated, isAdmin } from "./auth";
import { detectRecurring } from "./recurring";
import { createUser, getUserByEmail, isValidEmail, listPendingUsers, setUserStatus } from "./users";
import { encryptSecret } from "./crypto";
import { syncInvestment } from "./investments";

const app = new Hono<{ Bindings: Env }>();

// ---- auth (unprotected) ----------------------------------------------

// Owner login - unchanged from before.
app.post("/api/login", async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }));
  const ok = await loginAdmin(c, body.password ?? "");
  if (!ok) return c.json({ error: "wrong password" }, 401);
  return c.json({ ok: true });
});

// Anyone else: create an account. It starts 'pending' and cannot log in
// until the admin approves it from Settings.
app.post("/api/register", async (c) => {
  const body = await c.req
    .json<{ email?: string; password?: string }>()
    .catch(() => ({} as { email?: string; password?: string }));
  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  if (!isValidEmail(email)) return c.json({ error: "enter a valid email address" }, 400);
  if (password.length < 8) return c.json({ error: "password must be at least 8 characters" }, 400);

  const existing = await getUserByEmail(c.env, email);
  if (existing) return c.json({ error: "an account with this email already exists" }, 409);

  await createUser(c.env, email, password);
  return c.json({ ok: true, status: "pending" });
});

// Approved users log in here (kept separate from /api/login so the admin
// password path is never exposed to a form anyone else can submit to).
app.post("/api/login-user", async (c) => {
  const body = await c.req
    .json<{ email?: string; password?: string }>()
    .catch(() => ({} as { email?: string; password?: string }));
  const result = await loginUser(c, body.email ?? "", body.password ?? "");
  if (result === "ok") return c.json({ ok: true });
  if (result === "pending") return c.json({ error: "your account is still waiting for admin approval" }, 403);
  if (result === "rejected") return c.json({ error: "this account was not approved" }, 403);
  return c.json({ error: "wrong email or password" }, 401);
});

app.post("/api/logout", async (c) => {
  await logout(c);
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const session = await getSession(c);
  return c.json({
    authenticated: session !== null,
    isAdmin: session?.admin === true,
    email: session?.email,
  });
});

// ---- everything else under /api requires a valid session -------------

const PUBLIC_PATHS = new Set(["/api/login", "/api/register", "/api/login-user", "/api/me"]);

app.use("/api/*", async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();
  if (!(await isAuthenticated(c))) return c.json({ error: "unauthenticated" }, 401);
  return next();
});

// Admin-only: review and approve/reject pending self-registered accounts.
app.get("/api/users/pending", async (c) => {
  if (!(await isAdmin(c))) return c.json({ error: "admin only" }, 403);
  return c.json(await listPendingUsers(c.env));
});

app.post("/api/users/:id/approve", async (c) => {
  if (!(await isAdmin(c))) return c.json({ error: "admin only" }, 403);
  await setUserStatus(c.env, c.req.param("id"), "approved");
  return c.json({ ok: true });
});

app.post("/api/users/:id/reject", async (c) => {
  if (!(await isAdmin(c))) return c.json({ error: "admin only" }, 403);
  await setUserStatus(c.env, c.req.param("id"), "rejected");
  return c.json({ ok: true });
});

app.get("/api/institutions", async (c) => {
  const country = (c.req.query("country") || c.env.DEFAULT_COUNTRY || "DE").toUpperCase();
  const cacheKey = `institutions:${country}`;
  const cached = await c.env.KV.get(cacheKey, "json");
  if (cached) return c.json(cached);

  const list = await gc.listInstitutions(c.env, country);
  await c.env.KV.put(cacheKey, JSON.stringify(list), { expirationTtl: 60 * 60 * 12 });
  return c.json(list);
});

app.post("/api/connections", async (c) => {
  const body = await c.req.json<{
    institution_id: string;
    institution_name: string;
    institution_logo?: string;
  }>();
  if (!body.institution_id || !body.institution_name) {
    return c.json({ error: "institution_id and institution_name required" }, 400);
  }

  const reference = crypto.randomUUID();
  await db.createConnection(c.env, {
    id: reference,
    institution_id: body.institution_id,
    institution_name: body.institution_name,
    institution_logo: body.institution_logo,
  });

  const agreement = await gc.createAgreement(c.env, { institution_id: body.institution_id });
  const requisition = await gc.createRequisition(c.env, {
    institution_id: body.institution_id,
    agreement_id: agreement.id,
    reference,
    redirect: c.env.APP_REDIRECT_URL,
  });
  await db.setConnectionRequisition(c.env, reference, requisition.id);

  return c.json({ link: requisition.link });
});

app.get("/api/connections", async (c) => {
  return c.json(await db.listConnections(c.env));
});

// GoCardless redirects the user's browser here after they finish
// authenticating with their bank. `ref` is the reference we generated above.
app.get("/api/callback", async (c) => {
  const ref = c.req.query("ref");
  if (!ref) return c.redirect("/?error=missing_ref");

  const connection = await db.getConnectionByReference(c.env, ref);
  if (!connection) return c.redirect("/?error=unknown_connection");

  try {
    const requisition = await gc.getRequisition(c.env, connection.requisition_id as string);
    for (const accountId of requisition.accounts) {
      await syncAccount(c.env, accountId, {
        connection_id: connection.id as string,
        institution_id: connection.institution_id as string,
        institution_name: connection.institution_name as string,
        institution_logo: (connection.institution_logo as string) ?? undefined,
      });
    }
    await db.markConnectionLinked(c.env, connection.id as string);
  } catch (err) {
    await db.markConnectionError(c.env, connection.id as string);
    return c.redirect(`/?error=link_failed`);
  }

  return c.redirect("/?linked=1");
});

app.delete("/api/connections/:id", async (c) => {
  await db.removeConnection(c.env, c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/accounts", async (c) => {
  return c.json(await db.listAccounts(c.env));
});

app.get("/api/accounts/:id/transactions", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") || 100), 500);
  return c.json(await db.listTransactionsForAccount(c.env, c.req.param("id"), limit));
});

app.get("/api/transactions/recent", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") || 8), 200);
  return c.json(await db.listRecentTransactions(c.env, limit));
});

// Detected recurring payments (standing orders, subscriptions, direct
// debits) - computed on the fly from synced transaction history, nothing
// stored. See src/recurring.ts for the detection method and why.
app.get("/api/recurring", async (c) => {
  const rows = await db.listTransactionsForDetection(c.env);
  return c.json(detectRecurring(rows));
});

// ---- investments (read-only: crypto wallet address, Coinbase, eToro) --

app.get("/api/investments", async (c) => {
  const rows = (await db.listInvestmentsWithBalances(c.env)) as any[];
  const grouped = new Map<string, any>();
  for (const r of rows) {
    if (!grouped.has(r.id)) {
      grouped.set(r.id, {
        id: r.id,
        provider: r.provider,
        label: r.label,
        status: r.status,
        last_error: r.last_error,
        balances: [],
      });
    }
    if (r.asset) {
      grouped.get(r.id).balances.push({
        asset: r.asset,
        quantity: r.quantity,
        value_amount: r.value_amount,
        value_currency: r.value_currency,
      });
    }
  }
  return c.json([...grouped.values()]);
});

app.post("/api/investments", async (c) => {
  const body = await c.req.json<{
    provider?: "crypto_address" | "coinbase" | "etoro";
    label?: string;
    chain?: "BTC" | "ETH";
    address?: string;
    apiKey?: string;
    apiSecret?: string;
    userKey?: string;
  }>();

  if (!body.provider || !body.label) return c.json({ error: "provider and label required" }, 400);

  const id = crypto.randomUUID();
  let config_json = "{}";
  let secret_enc: string | null = null;

  if (body.provider === "crypto_address") {
    if (!body.chain || !body.address) return c.json({ error: "chain and address required" }, 400);
    config_json = JSON.stringify({ chain: body.chain, address: body.address.trim() });
  } else if (body.provider === "coinbase") {
    if (!body.apiKey || !body.apiSecret) return c.json({ error: "API key and secret required" }, 400);
    secret_enc = await encryptSecret(
      c.env,
      JSON.stringify({ apiKey: body.apiKey.trim(), apiSecret: body.apiSecret.trim() })
    );
  } else if (body.provider === "etoro") {
    if (!body.apiKey || !body.userKey) return c.json({ error: "x-api-key and x-user-key required" }, 400);
    secret_enc = await encryptSecret(
      c.env,
      JSON.stringify({ apiKey: body.apiKey.trim(), userKey: body.userKey.trim() })
    );
  } else {
    return c.json({ error: "unknown provider" }, 400);
  }

  await db.createInvestment(c.env, { id, provider: body.provider, label: body.label, config_json, secret_enc });

  // Sync immediately so the UI shows real data (or a clear error) right away.
  try {
    const row = await db.getInvestment(c.env, id);
    const balances = await syncInvestment(c.env, row as any);
    await db.replaceInvestmentBalances(c.env, id, balances);
    await db.markInvestmentOk(c.env, id);
  } catch (err: any) {
    await db.markInvestmentError(c.env, id, String(err?.message ?? err));
  }

  return c.json({ id });
});

app.delete("/api/investments/:id", async (c) => {
  await db.removeInvestment(c.env, c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/investments/sync", async (c) => {
  const rows = (await db.listInvestments(c.env)) as any[];
  for (const row of rows) {
    try {
      const full = await db.getInvestment(c.env, row.id);
      const balances = await syncInvestment(c.env, full as any);
      await db.replaceInvestmentBalances(c.env, row.id, balances);
      await db.markInvestmentOk(c.env, row.id);
    } catch (err: any) {
      await db.markInvestmentError(c.env, row.id, String(err?.message ?? err));
    }
  }
  return c.json({ ok: true });
});

// Refreshes balances + transactions for every linked account. Call this
// on-demand (e.g. a "Refresh" button) rather than on every page load -
// GoCardless free tier rate-limits calls per account per day.
app.post("/api/sync", async (c) => {
  const accountIds = await db.listAllAccountIds(c.env);
  const results: Array<{ accountId: string; ok: boolean; error?: string }> = [];
  for (const accountId of accountIds) {
    try {
      await syncAccountData(c.env, accountId);
      results.push({ accountId, ok: true });
    } catch (err: any) {
      results.push({ accountId, ok: false, error: String(err?.message ?? err) });
    }
  }
  return c.json({ results });
});

// ---- helpers -----------------------------------------------------------

async function syncAccount(
  env: Env,
  accountId: string,
  meta: {
    connection_id: string;
    institution_id: string;
    institution_name: string;
    institution_logo?: string;
  }
) {
  const details = await gc.getAccountDetails(env, accountId).catch(() => ({ account: {} } as any));
  await db.upsertAccount(env, {
    id: accountId,
    connection_id: meta.connection_id,
    institution_id: meta.institution_id,
    institution_name: meta.institution_name,
    institution_logo: meta.institution_logo,
    iban: details.account?.iban,
    display_name: details.account?.name || details.account?.product,
    owner_name: details.account?.ownerName,
    currency: details.account?.currency,
    product: details.account?.product,
  });
  await syncAccountData(env, accountId);
}

async function syncAccountData(env: Env, accountId: string) {
  const [balances, transactions] = await Promise.all([
    gc.getAccountBalances(env, accountId).catch(() => ({ balances: [] })),
    gc.getAccountTransactions(env, accountId).catch(() => ({ transactions: { booked: [] } })),
  ]);

  await db.replaceBalances(
    env,
    accountId,
    balances.balances.map((b) => ({
      balance_type: b.balanceType,
      amount: Number(b.balanceAmount.amount),
      currency: b.balanceAmount.currency,
    }))
  );

  const booked = transactions.transactions?.booked ?? [];
  const rows = await Promise.all(booked.map((t) => normalizeTransaction(accountId, t)));
  await db.insertTransactions(env, accountId, rows);
}

async function normalizeTransaction(accountId: string, t: Record<string, any>) {
  const amount = Number(t.transactionAmount?.amount ?? 0);
  const currency = t.transactionAmount?.currency ?? "EUR";
  const description =
    t.remittanceInformationUnstructured ||
    (Array.isArray(t.remittanceInformationUnstructuredArray)
      ? t.remittanceInformationUnstructuredArray.join(" ")
      : "") ||
    t.additionalInformation ||
    "";
  const counterparty = t.creditorName || t.debtorName || "";

  let id: string = t.transactionId || t.internalTransactionId;
  if (!id) {
    const raw = `${accountId}|${t.bookingDate}|${amount}|${currency}|${description}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  return {
    id,
    booking_date: t.bookingDate,
    value_date: t.valueDate,
    amount,
    currency,
    description,
    counterparty,
    raw_json: JSON.stringify(t),
  };
}

export default app;

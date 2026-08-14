import { Hono } from "hono";
import type { Env } from "./types";
import * as gc from "./gocardless";
import * as db from "./db";
import { login, logout, isAuthenticated } from "./auth";

const app = new Hono<{ Bindings: Env }>();

// ---- auth (unprotected) ----------------------------------------------

app.post("/api/login", async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => ({} as { password?: string }));
  const ok = await login(c, body.password ?? "");
  if (!ok) return c.json({ error: "wrong password" }, 401);
  return c.json({ ok: true });
});

app.post("/api/logout", async (c) => {
  await logout(c);
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  return c.json({ authenticated: await isAuthenticated(c) });
});

// ---- everything else under /api requires a valid session -------------

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/login" || c.req.path === "/api/me") return next();
  if (!(await isAuthenticated(c))) return c.json({ error: "unauthenticated" }, 401);
  return next();
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

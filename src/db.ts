import type { Env } from "./types";

export async function createConnection(
  env: Env,
  row: { id: string; institution_id: string; institution_name: string; institution_logo?: string }
) {
  await env.DB.prepare(
    `INSERT INTO connections (id, institution_id, institution_name, institution_logo, status)
     VALUES (?, ?, ?, ?, 'pending')`
  )
    .bind(row.id, row.institution_id, row.institution_name, row.institution_logo ?? null)
    .run();
}

export async function setConnectionRequisition(env: Env, id: string, requisitionId: string) {
  await env.DB.prepare(`UPDATE connections SET requisition_id = ? WHERE id = ?`)
    .bind(requisitionId, id)
    .run();
}

export async function getConnectionByReference(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM connections WHERE id = ?`).bind(id).first();
}

export async function markConnectionLinked(env: Env, id: string) {
  await env.DB.prepare(`UPDATE connections SET status = 'linked' WHERE id = ?`).bind(id).run();
}

export async function markConnectionError(env: Env, id: string) {
  await env.DB.prepare(`UPDATE connections SET status = 'error' WHERE id = ?`).bind(id).run();
}

export async function upsertAccount(
  env: Env,
  row: {
    id: string;
    connection_id: string;
    institution_id: string;
    institution_name: string;
    institution_logo?: string;
    iban?: string;
    display_name?: string;
    owner_name?: string;
    currency?: string;
    product?: string;
  }
) {
  await env.DB.prepare(
    `INSERT INTO accounts
       (id, connection_id, institution_id, institution_name, institution_logo, iban, display_name, owner_name, currency, product)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       owner_name = excluded.owner_name,
       currency = excluded.currency,
       product = excluded.product,
       status = 'active'`
  )
    .bind(
      row.id,
      row.connection_id,
      row.institution_id,
      row.institution_name,
      row.institution_logo ?? null,
      row.iban ?? null,
      row.display_name ?? null,
      row.owner_name ?? null,
      row.currency ?? null,
      row.product ?? null
    )
    .run();
}

export async function replaceBalances(
  env: Env,
  accountId: string,
  balances: Array<{ balance_type: string; amount: number; currency: string }>
) {
  const stmts = balances.map((b) =>
    env.DB.prepare(
      `INSERT INTO balances (account_id, balance_type, amount, currency, fetched_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(account_id, balance_type) DO UPDATE SET
         amount = excluded.amount, currency = excluded.currency, fetched_at = excluded.fetched_at`
    ).bind(accountId, b.balance_type, b.amount, b.currency)
  );
  if (stmts.length) await env.DB.batch(stmts);
}

export async function insertTransactions(
  env: Env,
  accountId: string,
  txns: Array<{
    id: string;
    booking_date?: string;
    value_date?: string;
    amount: number;
    currency: string;
    description?: string;
    counterparty?: string;
    raw_json: string;
  }>
) {
  if (!txns.length) return;
  const stmts = txns.map((t) =>
    env.DB.prepare(
      `INSERT INTO transactions
         (id, account_id, booking_date, value_date, amount, currency, description, counterparty, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(
      t.id,
      accountId,
      t.booking_date ?? null,
      t.value_date ?? null,
      t.amount,
      t.currency,
      t.description ?? null,
      t.counterparty ?? null,
      t.raw_json
    )
  );
  await env.DB.batch(stmts);
}

export async function listConnections(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM connections ORDER BY created_at DESC`
  ).all();
  return results;
}

export async function listAccounts(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT a.*,
        (SELECT amount FROM balances b WHERE b.account_id = a.id
           ORDER BY CASE b.balance_type WHEN 'interimAvailable' THEN 0 WHEN 'closingBooked' THEN 1 ELSE 2 END LIMIT 1) AS balance_amount,
        (SELECT currency FROM balances b WHERE b.account_id = a.id LIMIT 1) AS balance_currency,
        (SELECT fetched_at FROM balances b WHERE b.account_id = a.id LIMIT 1) AS balance_fetched_at
     FROM accounts a
     WHERE a.status = 'active'
     ORDER BY a.institution_name, a.display_name`
  ).all();
  return results;
}

export async function listTransactionsForAccount(env: Env, accountId: string, limit = 100) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM transactions WHERE account_id = ? ORDER BY booking_date DESC LIMIT ?`
  )
    .bind(accountId, limit)
    .all();
  return results;
}

export async function listAllAccountIds(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM accounts WHERE status = 'active'`
  ).all<{ id: string }>();
  return results.map((r) => r.id);
}

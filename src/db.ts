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
    `SELECT * FROM connections WHERE status != 'removed' ORDER BY created_at DESC`
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

export async function listRecentTransactions(env: Env, limit = 8) {
  const { results } = await env.DB.prepare(
    `SELECT t.*, a.institution_name, a.display_name, a.institution_logo
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE a.status = 'active'
     ORDER BY t.booking_date DESC, t.created_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();
  return results;
}

export async function removeConnection(env: Env, id: string) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE connections SET status = 'removed' WHERE id = ?`).bind(id),
    env.DB.prepare(`UPDATE accounts SET status = 'removed' WHERE connection_id = ?`).bind(id),
  ]);
}

export async function createInvestment(
  env: Env,
  row: { id: string; provider: string; label: string; config_json: string; secret_enc: string | null }
) {
  await env.DB.prepare(
    `INSERT INTO investments (id, provider, label, config_json, secret_enc, status) VALUES (?, ?, ?, ?, ?, 'active')`
  )
    .bind(row.id, row.provider, row.label, row.config_json, row.secret_enc)
    .run();
}

export async function getInvestment(env: Env, id: string) {
  return env.DB.prepare(`SELECT * FROM investments WHERE id = ?`).bind(id).first<{
    id: string;
    provider: string;
    label: string;
    config_json: string;
    secret_enc: string | null;
  }>();
}

export async function listInvestments(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, provider, label, status, last_error, created_at FROM investments WHERE status != 'removed' ORDER BY created_at DESC`
  ).all<{ id: string; provider: string; label: string; status: string; last_error: string | null }>();
  return results;
}

export async function listInvestmentsWithBalances(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.provider, i.label, i.status, i.last_error, i.config_json,
            b.asset, b.quantity, b.value_amount, b.value_currency, b.fetched_at
     FROM investments i
     LEFT JOIN investment_balances b ON b.investment_id = i.id
     WHERE i.status != 'removed'
     ORDER BY i.created_at DESC`
  ).all();
  return results;
}

export async function removeInvestment(env: Env, id: string) {
  await env.DB.prepare(`UPDATE investments SET status = 'removed' WHERE id = ?`).bind(id).run();
}

export async function markInvestmentOk(env: Env, id: string) {
  await env.DB.prepare(`UPDATE investments SET status = 'active', last_error = NULL WHERE id = ?`).bind(id).run();
}

export async function markInvestmentError(env: Env, id: string, message: string) {
  await env.DB.prepare(`UPDATE investments SET status = 'error', last_error = ? WHERE id = ?`).bind(message, id).run();
}

export async function replaceInvestmentBalances(
  env: Env,
  investmentId: string,
  balances: Array<{ asset: string; quantity: number | null; value_amount: number; value_currency: string }>
) {
  await env.DB.prepare(`DELETE FROM investment_balances WHERE investment_id = ?`).bind(investmentId).run();
  if (!balances.length) return;
  const stmts = balances.map((b) =>
    env.DB.prepare(
      `INSERT INTO investment_balances (investment_id, asset, quantity, value_amount, value_currency, fetched_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(investmentId, b.asset, b.quantity, b.value_amount, b.value_currency)
  );
  await env.DB.batch(stmts);
}

export async function listTransactionsForDetection(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT t.account_id, a.institution_name, t.booking_date, t.amount, t.currency, t.description, t.counterparty
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     WHERE a.status = 'active' AND t.booking_date IS NOT NULL
     ORDER BY t.account_id, t.booking_date`
  ).all<{
    account_id: string;
    institution_name: string;
    booking_date: string;
    amount: number;
    currency: string;
    description: string | null;
    counterparty: string | null;
  }>();
  return results;
}

export async function listAllAccountIds(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM accounts WHERE status = 'active'`
  ).all<{ id: string }>();
  return results.map((r) => r.id);
}

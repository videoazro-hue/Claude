-- Bank aggregator schema
-- One row per GoCardless "requisition" (a single bank-linking flow)
CREATE TABLE connections (
  id TEXT PRIMARY KEY,                  -- GoCardless requisition id
  institution_id TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  institution_logo TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | linked | expired | error
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per bank account returned by a linked connection
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                  -- GoCardless account id
  connection_id TEXT NOT NULL REFERENCES connections(id),
  institution_id TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  institution_logo TEXT,
  iban TEXT,
  display_name TEXT,
  owner_name TEXT,
  currency TEXT,
  product TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE balances (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  balance_type TEXT NOT NULL,           -- e.g. interimAvailable, closingBooked
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, balance_type)
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,                  -- provider transactionId, or a stable hash fallback
  account_id TEXT NOT NULL REFERENCES accounts(id),
  booking_date TEXT,
  value_date TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  description TEXT,
  counterparty TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_transactions_account ON transactions(account_id);
CREATE INDEX idx_transactions_date ON transactions(booking_date);
CREATE INDEX idx_accounts_connection ON accounts(connection_id);

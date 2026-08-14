-- Read-only investment connections (crypto wallets by public address,
-- Coinbase, eToro). Credentials (when a provider needs any) are stored
-- encrypted in secret_enc - see src/crypto.ts. Crypto wallet connections
-- have no secret_enc at all: a public address can only be read, never used
-- to move funds, so there is nothing to encrypt or steal for that provider.
CREATE TABLE investments (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,             -- 'crypto_address' | 'coinbase' | 'etoro'
  label TEXT NOT NULL,
  config_json TEXT NOT NULL,          -- provider-specific non-secret config (e.g. chain + address)
  secret_enc TEXT,                    -- AES-GCM encrypted credentials JSON, or NULL
  status TEXT NOT NULL DEFAULT 'active', -- active | error | removed
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE investment_balances (
  investment_id TEXT NOT NULL REFERENCES investments(id),
  asset TEXT NOT NULL,                -- e.g. 'BTC', 'ETH', 'EUR'
  quantity REAL,                      -- native units, NULL for pure-cash balances
  value_amount REAL NOT NULL,         -- value in value_currency
  value_currency TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (investment_id, asset)
);

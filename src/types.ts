export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;

  DEFAULT_COUNTRY: string;
  APP_REDIRECT_URL: string;

  // secrets
  GC_SECRET_ID: string;
  GC_SECRET_KEY: string;
  APP_PASSWORD: string;
}

export interface Institution {
  id: string;
  name: string;
  bic?: string;
  logo?: string;
  countries: string[];
  transaction_total_days?: string;
}

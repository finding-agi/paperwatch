import pg from 'pg'
import { log } from './bot.ts'

// Postgres (Supabase) copy of the site's state: users and their sealed trading keys, limit orders, the fee scanner's
// position, and an append-only log of what users do. The in-memory stores stay the working copy; every save mirrors the
// rows that changed, in order, one batch at a time. Call flush() before anything irreversible (a relayer send), so a
// crash can never leave the database behind what was sent. Without DATABASE_URL this is all a no-op.

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

// The live project also revokes every privilege on this schema from Supabase's public API roles (anon, authenticated);
// see the paperwatch_initial migration. Only the server's own Postgres login can read the sealed keys.
export const SCHEMA = `
create schema if not exists paperwatch;
create table if not exists paperwatch.users (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists paperwatch.orders (
  id text primary key,
  data jsonb not null,
  wallet text generated always as (data->>'wallet') stored,
  status text generated always as (data->>'status') stored,
  updated_at timestamptz not null default now()
);
create index if not exists orders_wallet on paperwatch.orders (wallet);
create table if not exists paperwatch.kv (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists paperwatch.events (
  id bigserial primary key,
  at timestamptz not null default now(),
  wallet text,
  type text not null,
  data jsonb not null default '{}'
);
create index if not exists events_wallet_at on paperwatch.events (wallet, at);
create index if not exists events_type_at on paperwatch.events (type, at);
alter table paperwatch.users enable row level security;
alter table paperwatch.orders enable row level security;
alter table paperwatch.kv enable row level security;
alter table paperwatch.events enable row level security;
`

/** The rows to write so the table matches `next`, given what was last written. */
export function diffRows(last: Map<string, string>, next: Map<string, string>) {
  const upserts = [...next].filter(([id, json]) => last.get(id) !== json)
  const deletes = [...last.keys()].filter((id) => !next.has(id))
  return { upserts, deletes }
}

type Table = 'users' | 'orders'

export class Db {
  readonly #query: Query
  readonly #saved = new Map<Table, Map<string, string>>()
  #chain: Promise<void> = Promise.resolve()
  #failing = false

  constructor(query: Query) {
    this.#query = query
  }

  /** Connect from DATABASE_URL (Supabase's pooler string), or null when it isn't set. */
  static fromEnv(): Db | null {
    const url = process.env.DATABASE_URL
    if (!url) return null
    // TLS always. With PT_DATABASE_CA (the project's CA certificate, PEM) the server's certificate is checked too.
    const ca = process.env.PT_DATABASE_CA
    const pool = new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: ca ? { ca } : { rejectUnauthorized: false }, max: 5 })
    pool.on('error', (err) => log('warn', `database: ${err.message}`))
    return new Db((sql, params) => pool.query(sql, params))
  }

  async init(): Promise<void> {
    await this.#query(SCHEMA)
  }

  /** Every row of a table, by id; also records them as already written. */
  async load<T>(table: Table): Promise<Map<string, T>> {
    const { rows } = await this.#query(`select id, data from paperwatch.${table}`)
    const out = new Map<string, T>()
    const saved = new Map<string, string>()
    for (const r of rows) {
      out.set(String(r.id), r.data as T)
      saved.set(String(r.id), JSON.stringify(r.data))
    }
    this.#saved.set(table, saved)
    return out
  }

  /**
   * Make the table hold exactly `rows` (id → record). Snapshots now, writes in the background; a failed write is
   * retried on the next save because only rows that reached the database count as written.
   */
  sync(table: Table, rows: Iterable<[string, unknown]>): void {
    const next = new Map([...rows].map(([id, v]) => [id, JSON.stringify(v)] as [string, string]))
    this.#enqueue(async () => {
      const saved = this.#saved.get(table) ?? new Map<string, string>()
      const { upserts, deletes } = diffRows(saved, next)
      if (upserts.length) {
        await this.#query(
          `insert into paperwatch.${table} (id, data) select * from unnest($1::text[], $2::jsonb[])
           on conflict (id) do update set data = excluded.data, updated_at = now()`,
          [upserts.map(([id]) => id), upserts.map(([, json]) => json)],
        )
        for (const [id, json] of upserts) saved.set(id, json)
      }
      if (deletes.length) {
        await this.#query(`delete from paperwatch.${table} where id = any($1::text[])`, [deletes])
        for (const id of deletes) saved.delete(id)
      }
      this.#saved.set(table, saved)
    })
  }

  /** Write one key/value row (e.g. the fee scanner's last block). */
  put(id: string, data: unknown): void {
    this.#enqueue(() =>
      this.#query(
        `insert into paperwatch.kv (id, data) values ($1, $2) on conflict (id) do update set data = excluded.data, updated_at = now()`,
        [id, JSON.stringify(data)],
      ).then(() => {}),
    )
  }

  async get<T>(id: string): Promise<T | null> {
    const { rows } = await this.#query('select data from paperwatch.kv where id = $1', [id])
    return (rows[0]?.data as T) ?? null
  }

  /** Append one user action to the activity log. */
  event(type: string, wallet: string | null, data: Record<string, unknown> = {}): void {
    this.#enqueue(() =>
      this.#query('insert into paperwatch.events (type, wallet, data) values ($1, $2, $3)', [type, wallet?.toLowerCase() ?? null, JSON.stringify(data)]).then(() => {}),
    )
  }

  /** Wait for every write so far. Rejects if the last one failed (and the database is still behind). */
  async flush(): Promise<void> {
    await this.#chain
    if (this.#failing) throw new Error('database write failed; not sending until it recovers')
  }

  #enqueue(write: () => Promise<void>): void {
    this.#chain = this.#chain.then(write).then(
      () => {
        if (this.#failing) log('db', 'database writes recovered')
        this.#failing = false
      },
      (err: Error) => {
        if (!this.#failing) log('warn', `database write failed: ${err.message}`)
        this.#failing = true
      },
    )
  }
}

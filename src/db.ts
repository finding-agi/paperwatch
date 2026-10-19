import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import type { Address, Hex } from 'viem'
import { log } from './bot.ts'
import { STATE_DIR } from './config.ts'
import { randomNonceStart } from './state.ts'
import type { OrderStatus, TriggerOrder } from './trigger.ts'
import type { UserRecord } from './users.ts'

// The site's state lives in Postgres (Supabase in production): wallets and their sealed trading keys, limit orders,
// pending sign-ins, closes on their way, the fee scanner's block and an activity log. Every change is one conditional
// write (an order is claimed for sending only if it is still armed, a nonce comes from an atomic counter, a payment
// unlocks one wallet), so several server instances can share it safely. Each instance keeps a replica in memory for
// reads, refreshed from rows changed since its last look; its own writes land in the replica straight away.

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>

// The live project also revokes every privilege on this schema from Supabase's public API roles (anon, authenticated);
// see the paperwatch_initial migration. Only the server's own Postgres login can read the sealed keys.
export const SCHEMA = `
create schema if not exists paperwatch;
create or replace function paperwatch.touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

create table if not exists paperwatch.wallets (
  wallet text primary key,
  created_at timestamptz not null default now(),
  next_nonce numeric not null,
  key_address text,
  key_sealed text,
  key_expiry bigint,
  key_submitted_at timestamptz,
  key_registered_at timestamptz,
  pending_key jsonb,
  fee_tx text unique,
  fee_paid_at timestamptz,
  fee_wei numeric,
  updated_at timestamptz not null default now()
);
create index if not exists wallets_updated on paperwatch.wallets (updated_at);

create table if not exists paperwatch.orders (
  id text primary key,
  data jsonb not null,
  wallet text generated always as (data->>'wallet') stored,
  status text generated always as (data->>'status') stored,
  updated_at timestamptz not null default now()
);
create index if not exists orders_wallet on paperwatch.orders (wallet);
create index if not exists orders_updated on paperwatch.orders (updated_at);

create table if not exists paperwatch.sign_ins (
  wallet text primary key,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists paperwatch.closes (
  position_id text primary key,
  wallet text not null,
  intent_id text,
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists closes_updated on paperwatch.closes (updated_at);
-- Closes are queued by the web instances and sent by the worker: requested -> sending -> sent, or failed (with why).
alter table paperwatch.closes add column if not exists status text not null default 'requested';
alter table paperwatch.closes add column if not exists error text;

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

drop trigger if exists wallets_touch on paperwatch.wallets;
create trigger wallets_touch before update on paperwatch.wallets for each row execute function paperwatch.touch();
drop trigger if exists orders_touch on paperwatch.orders;
create trigger orders_touch before update on paperwatch.orders for each row execute function paperwatch.touch();
drop trigger if exists closes_touch on paperwatch.closes;
create trigger closes_touch before update on paperwatch.closes for each row execute function paperwatch.touch();

alter table paperwatch.wallets enable row level security;
alter table paperwatch.orders enable row level security;
alter table paperwatch.sign_ins enable row level security;
alter table paperwatch.closes enable row level security;
alter table paperwatch.kv enable row level security;
alter table paperwatch.events enable row level security;
`

const KEEP_DONE = 50 // finished orders kept per wallet
const REFRESH_OVERLAP_MS = 5000 // re-read rows changed this long before the last look, for writes still committing
const CLOSE_STALE_MS = 10 * 60_000 // a close claim this old no longer blocks another close
// Connections per process. Supabase's free session pooler takes ~15 clients in all: 2 web replicas + the worker
// (its pool plus the lock's own connection) stay near 10.
const POOL_MAX = Number(process.env.PT_DB_POOL_MAX ?? 3)
const WORKER_LOCK = 7_277_001 // advisory lock id: only the process holding it sends orders and closes

export type CloseStatus = 'requested' | 'sending' | 'sent' | 'failed'
export type Close = { positionId: string; wallet: Address; intentId: Hex | null; done: boolean; status: CloseStatus; error: string | null; at: number; updatedAt: number }

const time = (v: unknown) => (v == null ? undefined : new Date(v as string).getTime())

function toUser(r: Record<string, any>): UserRecord {
  return {
    wallet: r.wallet,
    createdAt: time(r.created_at)!,
    nextNonce: String(r.next_nonce),
    ...(r.key_address
      ? { key: { address: r.key_address, sealed: r.key_sealed, expiry: Number(r.key_expiry), submittedAt: time(r.key_submitted_at), registeredAt: time(r.key_registered_at) } }
      : {}),
    ...(r.fee_tx ? { fee: { tx: r.fee_tx, paidAt: time(r.fee_paid_at)!, wei: String(r.fee_wei) } } : {}),
    ...(r.pending_key ? { pendingKey: r.pending_key } : {}),
  }
}

const toClose = (r: Record<string, any>): Close => ({
  positionId: r.position_id, wallet: r.wallet, intentId: r.intent_id, done: r.done, status: r.status, error: r.error, at: time(r.created_at)!, updatedAt: time(r.updated_at)!,
})

/** Replace `target`'s fields with `next`'s, keeping the object (code holding it sees the change). */
function merge<T extends object>(target: T, next: T): T {
  for (const k of Object.keys(target)) if (!(k in next)) delete (target as Record<string, unknown>)[k]
  return Object.assign(target, next)
}

/** The done orders to drop: past the newest KEEP_DONE per wallet. */
export function prunable(orders: Iterable<TriggerOrder>, keep = KEEP_DONE): Set<string> {
  const done = new Map<string, TriggerOrder[]>()
  for (const o of orders) {
    if (o.status === 'armed' || o.status === 'sending' || o.status === 'sent') continue
    done.set(o.wallet, [...(done.get(o.wallet) ?? []), o])
  }
  const drop = new Set<string>()
  for (const list of done.values()) for (const o of list.sort((a, b) => b.createdAt - a.createdAt).slice(keep)) drop.add(o.id)
  return drop
}

export class Store {
  readonly users = new Map<string, UserRecord>()
  readonly orders = new Map<string, TriggerOrder>()
  readonly closes = new Map<string, Close>()
  readonly #query: Query
  readonly #session: () => Promise<Query>
  readonly #cursor = { wallets: new Date(0), orders: new Date(0), closes: new Date(0) }
  #events: Promise<void> = Promise.resolve()

  /** `session` hands out a connection of its own (for the worker's lock); by default the shared one. */
  constructor(query: Query, session: () => Promise<Query> = async () => query) {
    this.#query = query
    this.#session = session
  }

  /**
   * Connect to DATABASE_URL (Supabase's session pooler string). Without it, and only off Railway, use an embedded
   * Postgres in the state dir so local runs work the same way.
   */
  static async open(deployed: boolean): Promise<Store> {
    const url = process.env.DATABASE_URL
    if (url) {
      // TLS always. With PT_DATABASE_CA (the project's CA certificate, PEM) the server's certificate is checked too.
      const ca = process.env.PT_DATABASE_CA
      const pool = new pg.Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: ca ? { ca } : { rejectUnauthorized: false }, max: POOL_MAX })
      pool.on('error', (err) => log('warn', `database: ${err.message}`))
      const session = async (): Promise<Query> => {
        const client = await pool.connect() // never released: a session-level lock lives as long as this connection
        client.on('error', (err) => log('warn', `database session: ${err.message}`))
        return (sql, params) => client.query(sql, params)
      }
      return Store.#start(new Store((sql, params) => pool.query(sql, params), session))
    }
    if (deployed) throw new Error('set DATABASE_URL (deployed, the database is required)')
    const { PGlite } = await import('@electric-sql/pglite')
    mkdirSync(STATE_DIR, { recursive: true })
    const lite = new PGlite(join(STATE_DIR, 'pglite'))
    log('db', `no DATABASE_URL: using a local database in ${join(STATE_DIR, 'pglite')}`)
    return Store.#start(new Store(liteQuery(lite)))
  }

  static async #start(store: Store): Promise<Store> {
    await store.init()
    await store.importLegacy()
    await store.refresh()
    return store
  }

  async init(): Promise<void> {
    await this.#query(SCHEMA)
  }

  /**
   * One time, into empty tables: wallets from the first database version (paperwatch.users, one JSON blob per wallet)
   * or users.json, and orders from the first version's rows or trigger-orders.json.
   */
  async importLegacy(dir = STATE_DIR): Promise<void> {
    const { rows: w } = await this.#query('select count(*)::int as n from paperwatch.wallets')
    if (!w[0].n) {
      let legacy: UserRecord[] = []
      const { rows: t } = await this.#query(`select to_regclass('paperwatch.users') is not null as has`)
      if (t[0].has) legacy = (await this.#query('select data from paperwatch.users')).rows.map((r) => r.data)
      if (!legacy.length && existsSync(join(dir, 'users.json'))) legacy = Object.values(JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8')))
      for (const u of legacy) {
        await this.#query(
          `insert into paperwatch.wallets (wallet, created_at, next_nonce, key_address, key_sealed, key_expiry, key_submitted_at, key_registered_at,
             pending_key, fee_tx, fee_paid_at, fee_wei)
           values ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), $9, $10, to_timestamp($11 / 1000.0), $12)
           on conflict do nothing`,
          [u.wallet.toLowerCase(), u.createdAt, u.nextNonce, u.key?.address ?? null, u.key?.sealed ?? null, u.key?.expiry ?? null,
            u.key?.submittedAt ?? null, u.key?.registeredAt ?? null, u.pendingKey ? JSON.stringify(u.pendingKey) : null,
            u.fee?.tx.toLowerCase() ?? null, u.fee?.paidAt ?? null, u.fee?.wei ?? null],
        )
      }
      if (legacy.length) log('db', `imported ${legacy.length} wallet(s)`)
    }
    // The first version's orders table has the same shape, so its rows are already in place; only a file needs copying.
    const { rows: o } = await this.#query('select count(*)::int as n from paperwatch.orders')
    if (!o[0].n && existsSync(join(dir, 'trigger-orders.json'))) {
      const orders = JSON.parse(readFileSync(join(dir, 'trigger-orders.json'), 'utf8')) as TriggerOrder[]
      for (const order of orders) await this.#query('insert into paperwatch.orders (id, data) values ($1, $2) on conflict do nothing', [order.id, JSON.stringify(order)])
      if (orders.length) log('db', `imported ${orders.length} order(s)`)
    }
  }

  /** Pull every row changed since the last look into the replica. */
  async refresh(): Promise<void> {
    const since = (d: Date) => new Date(d.getTime() - REFRESH_OVERLAP_MS)
    const [w, o, c] = await Promise.all([
      this.#query('select *, now() as seen from paperwatch.wallets where updated_at > $1', [since(this.#cursor.wallets)]),
      this.#query('select data, now() as seen from paperwatch.orders where updated_at > $1', [since(this.#cursor.orders)]),
      this.#query('select *, now() as seen from paperwatch.closes where updated_at > $1', [since(this.#cursor.closes)]),
    ])
    for (const r of w.rows) this.#putUser(r)
    for (const r of o.rows) this.#putOrder(r.data)
    for (const r of c.rows) this.#putClose(r)
    // An empty result has no row to carry now(); keep the cursor, the overlap covers it.
    if (w.rows[0]) this.#cursor.wallets = new Date(w.rows[0].seen)
    if (o.rows[0]) this.#cursor.orders = new Date(o.rows[0].seen)
    if (c.rows[0]) this.#cursor.closes = new Date(c.rows[0].seen)
    for (const id of prunable(this.orders.values())) this.orders.delete(id)
  }

  /** Delete finished orders past the newest KEEP_DONE per wallet (every replica drops the same ones on its own). */
  async pruneOrders(): Promise<void> {
    await this.#query(
      `delete from paperwatch.orders where id in (
         select id from (select id, row_number() over (partition by wallet order by (data->>'createdAt')::bigint desc) as n
                         from paperwatch.orders where status not in ('armed', 'sending', 'sent')) ranked
         where n > $1)`,
      [KEEP_DONE],
    )
  }

  #putUser(r: Record<string, any>): UserRecord {
    const next = toUser(r)
    const have = this.users.get(next.wallet)
    if (have) return merge(have, next)
    this.users.set(next.wallet, next)
    return next
  }

  #putOrder(next: TriggerOrder): TriggerOrder {
    const have = this.orders.get(next.id)
    if (have) return merge(have, next)
    this.orders.set(next.id, next)
    return next
  }

  #putClose(r: Record<string, any>): Close {
    const next = toClose(r)
    this.closes.set(next.positionId, next)
    return next
  }

  // ---- wallets ----------------------------------------------------------------------------------------------------

  async ensureUser(wallet: Address): Promise<UserRecord> {
    const id = wallet.toLowerCase()
    await this.#query('insert into paperwatch.wallets (wallet, next_nonce) values ($1, $2) on conflict do nothing', [id, String(randomNonceStart())])
    const { rows } = await this.#query('select * from paperwatch.wallets where wallet = $1', [id])
    return this.#putUser(rows[0])
  }

  async #updateUser(wallet: string, set: string, params: unknown[], where = ''): Promise<UserRecord | null> {
    const { rows } = await this.#query(`update paperwatch.wallets set ${set} where wallet = $1 ${where} returning *`, [wallet.toLowerCase(), ...params])
    return rows[0] ? this.#putUser(rows[0]) : null
  }

  /** Record the unlock payment; false if that transaction already unlocked a wallet. */
  async setFee(wallet: Address, fee: NonNullable<UserRecord['fee']>): Promise<boolean> {
    await this.ensureUser(wallet)
    try {
      return Boolean(await this.#updateUser(wallet, 'fee_tx = $2, fee_paid_at = to_timestamp($3 / 1000.0), fee_wei = $4', [fee.tx.toLowerCase(), fee.paidAt, fee.wei], 'and fee_tx is null'))
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return false // unique violation: used by another wallet
      throw err
    }
  }

  isFeeTxUsed(tx: string): boolean {
    const t = tx.toLowerCase()
    for (const u of this.users.values()) if (u.fee?.tx.toLowerCase() === t) return true
    return false
  }

  async setPendingKey(wallet: Address, pending: NonNullable<UserRecord['pendingKey']>): Promise<void> {
    await this.#updateUser(wallet, 'pending_key = $2', [JSON.stringify(pending)])
  }

  /** Make the approved pending key the wallet's trading key (only if it is still the one waiting). */
  async activateKey(wallet: Address, key: NonNullable<UserRecord['key']>): Promise<UserRecord | null> {
    return this.#updateUser(
      wallet,
      'key_address = $2, key_sealed = $3, key_expiry = $4, key_submitted_at = to_timestamp($5 / 1000.0), key_registered_at = to_timestamp($6 / 1000.0), pending_key = null',
      [key.address, key.sealed, key.expiry, key.submittedAt ?? null, key.registeredAt ?? null],
      "and pending_key->>'address' = $2",
    )
  }

  async markKeyRegistered(wallet: Address, keyAddress: string): Promise<void> {
    await this.#updateUser(wallet, 'key_registered_at = now()', [keyAddress.toLowerCase()], 'and lower(key_address) = $2')
  }

  async clearKey(wallet: Address): Promise<void> {
    await this.#updateUser(wallet, 'key_address = null, key_sealed = null, key_expiry = null, key_submitted_at = null, key_registered_at = null', [])
  }

  /** The wallet's next intent nonce, from an atomic counter: two sends can never get the same one. */
  async takeNonce(wallet: Address): Promise<bigint> {
    const { rows } = await this.#query('update paperwatch.wallets set next_nonce = next_nonce + 1 where wallet = $1 returning *', [wallet.toLowerCase()])
    if (!rows[0]) throw new Error('unknown wallet')
    this.#putUser(rows[0])
    return BigInt(rows[0].next_nonce) - 1n
  }

  /** Jump to a fresh random nonce range (the counter's next one was already used on-chain). */
  async jumpNonce(wallet: Address): Promise<void> {
    await this.#updateUser(wallet, 'next_nonce = $2', [String(randomNonceStart())])
  }

  // ---- orders -----------------------------------------------------------------------------------------------------

  async addOrder(o: TriggerOrder): Promise<TriggerOrder> {
    const { rows } = await this.#query('insert into paperwatch.orders (id, data) values ($1, $2) returning data', [o.id, JSON.stringify(o)])
    return this.#putOrder(rows[0].data)
  }

  /**
   * Apply `patch` only if the order's status is one of `from`; null if it wasn't (another instance, or a cancel, got
   * there first). Fields set to undefined are removed.
   */
  async transition(id: string, from: OrderStatus[], patch: Partial<TriggerOrder>): Promise<TriggerOrder | null> {
    const drop = Object.keys(patch).filter((k) => patch[k as keyof TriggerOrder] === undefined)
    const { rows } = await this.#query(
      `update paperwatch.orders set data = (data || $2::jsonb) - $4::text[] where id = $1 and data->>'status' = any($3::text[]) returning data`,
      [id, JSON.stringify(patch), from, drop],
    )
    return rows[0] ? this.#putOrder(rows[0].data) : null
  }

  // ---- sign-ins ---------------------------------------------------------------------------------------------------

  async putSignIn(wallet: Address, message: string): Promise<void> {
    await this.#query(
      `insert into paperwatch.sign_ins (wallet, message) values ($1, $2)
       on conflict (wallet) do update set message = excluded.message, created_at = now()`,
      [wallet.toLowerCase(), message],
    )
    if (Math.random() < 0.01) await this.#query(`delete from paperwatch.sign_ins where created_at < now() - interval '1 hour'`)
  }

  /** The wallet's pending sign-in message, used up by this call; null if none or older than `ttlMs`. */
  async takeSignIn(wallet: Address, ttlMs: number): Promise<string | null> {
    const { rows } = await this.#query(
      `delete from paperwatch.sign_ins where wallet = $1 and created_at > now() - make_interval(secs => $2) returning message`,
      [wallet.toLowerCase(), ttlMs / 1000],
    )
    return rows[0]?.message ?? null
  }

  // ---- closes -----------------------------------------------------------------------------------------------------

  /** Queue a close for the worker; false while another close for this position is on its way. */
  async claimClose(positionId: string, wallet: Address): Promise<boolean> {
    const { rows } = await this.#query(
      `insert into paperwatch.closes (position_id, wallet) values ($1, $2)
       on conflict (position_id) do update set wallet = excluded.wallet, intent_id = null, done = false, status = 'requested', error = null, created_at = now()
         where paperwatch.closes.done or paperwatch.closes.created_at < now() - make_interval(secs => $3)
       returning *`,
      [positionId, wallet.toLowerCase(), CLOSE_STALE_MS / 1000],
    )
    if (rows[0]) this.#putClose(rows[0])
    return Boolean(rows[0])
  }

  /** The worker takes a requested close to send it; null if it was already taken. */
  async takeClose(positionId: string): Promise<Close | null> {
    const { rows } = await this.#query(`update paperwatch.closes set status = 'sending' where position_id = $1 and status = 'requested' and not done returning *`, [positionId])
    return rows[0] ? this.#putClose(rows[0]) : null
  }

  async setClose(positionId: string, patch: { intentId?: Hex; done?: boolean; status?: CloseStatus; error?: string }): Promise<void> {
    const { rows } = await this.#query(
      `update paperwatch.closes set intent_id = coalesce($2, intent_id), done = coalesce($3, done), status = coalesce($4, status), error = coalesce($5, error)
       where position_id = $1 returning *`,
      [positionId, patch.intentId ?? null, patch.done ?? null, patch.status ?? null, patch.error ?? null],
    )
    if (rows[0]) this.#putClose(rows[0])
  }

  // ---- the worker's lock --------------------------------------------------------------------------------------------

  /**
   * Wait until this process holds the worker lock (a Postgres session-level advisory lock), then keep checking the
   * connection that holds it. If that connection fails the lock may be gone, so `onLost` runs (the worker exits).
   */
  async workerLock(onLost: (why: string) => void, retryMs = 5000): Promise<void> {
    const q = await this.#session()
    let waited = false
    while (!(await q('select pg_try_advisory_lock($1) as ok', [WORKER_LOCK])).rows[0].ok) {
      if (!waited) log('db', 'another worker holds the lock; waiting for it')
      waited = true
      await new Promise((ok) => setTimeout(ok, retryMs))
    }
    const timer = setInterval(() => {
      q('select 1').catch((err: Error) => {
        clearInterval(timer)
        onLost(err.message)
      })
    }, 10_000)
    timer.unref()
  }

  // ---- key/value and activity -------------------------------------------------------------------------------------

  async put(id: string, data: unknown): Promise<void> {
    await this.#query(
      'insert into paperwatch.kv (id, data) values ($1, $2) on conflict (id) do update set data = excluded.data, updated_at = now()',
      [id, JSON.stringify(data)],
    )
  }

  async get<T>(id: string): Promise<T | null> {
    const { rows } = await this.#query('select data from paperwatch.kv where id = $1', [id])
    return (rows[0]?.data as T) ?? null
  }

  /** Append one user action to the activity log (in the background, in order; a failure is logged, not thrown). */
  event(type: string, wallet: string | null, data: Record<string, unknown> = {}): void {
    this.#events = this.#events
      .then(() => this.#query('insert into paperwatch.events (type, wallet, data) values ($1, $2, $3)', [type, wallet?.toLowerCase() ?? null, JSON.stringify(data)]))
      .then(
        () => {},
        (err: Error) => log('warn', `activity log: ${err.message}`),
      )
  }

  async flushEvents(): Promise<void> {
    await this.#events
  }
}

/** pg's Pool runs a parameterless multi-statement string as one simple query; PGlite needs exec() for that. */
export function liteQuery(lite: { query: Function; exec: Function }): Query {
  return async (sql, params) => (params ? lite.query(sql, params) : ((await lite.exec(sql)).at(-1) ?? { rows: [] }))
}

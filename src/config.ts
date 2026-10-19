import type { Address } from 'viem'

export const CHAIN_ID = 999
export const RPC_URL = process.env.PT_RPC_URL || 'https://rpc.hyperliquid.xyz/evm'
export const API_URL = process.env.PT_API_URL || 'https://exchange.papertrade.xyz'
export const USER_AGENT = 'paperwatch/1.0 (+https://paperwatch.app)'
// On Railway these point at a mounted volume so state survives restarts and redeploys.
export const STATE_DIR = process.env.PT_STATE_DIR || '.state'
export const SECRETS_DIR = process.env.PT_SECRETS_DIR || '.secrets'

// Proxy addresses (the ones to call). All owned by the Timelock (7-day delay), which is owned by the multisig.
export const CONTRACTS = {
  exchange: '0x6cd5661646289FB6E65EA5C032310fDEd797D0a2',
  batchExecutor: '0x233Ff29b239abc1D7748605dA9b205C3e008626E',
  sessionKeyManager: '0x8326Eb8896e358717f10502Ec73CE8D28E37B108',
  paperStaking: '0xAAd6c7b0CC3014FC80FfEDAe0Ed7Ce5967b0F016',
  paperTokenomics: '0x75174549dbBD44497D31a47E2E2D7406408d63D9',
  timelock: '0xB915Fa41e824D6aA31BB833Ee81220C0F2c8EA0F',
  multisig: '0x696292762fD5AC3677a45EdBe54EAECE4194d1F6',
} as const satisfies Record<string, Address>

// HyperCore L1-read precompile the PriceOracle uses: (bid, ask) for an asset index.
export const BBO_PRECOMPILE: Address = '0x000000000000000000000000000000000000080e'

export const WAD = 10n ** 18n
// Internal USD amounts are 18-dec, backed by 6-dec USDC, so margins are rounded to this unit.
export const USDC_UNIT = 10n ** 12n
export const INTENT_TTL_SEC = 3600n
export const SESSION_TTL_SEC = 30n * 24n * 3600n
export const MAX_CLOSE_IDS = 12
export const MIN_MARGIN_USD = 10
export const MIN_NOTIONAL_USD = 1000

export type StrategyConfig = {
  instrument: 'BTC' | 'ETH'
  legNotionalUsd: number
  leverage: number
  resetMove: number
  maxPairs: number
  minBustDistance: number
  queueGuardMove: number
  maxDailyCostUsd: number
  tickMs: number
  openWaitMs: number
  closeWaitMs: number
  closeOnExit: boolean
  // 'pair': close both legs once either is resetMove against entry. 'spread': close and reopen any leg that is
  // restrikeMove against its own entry, and close both once either leg is takeMove in profit.
  mode: 'pair' | 'spread'
  restrikeMove: number
  takeMove: number
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${raw}"`)
  return n
}

export function loadStrategyConfig(env: NodeJS.ProcessEnv = process.env): StrategyConfig {
  const instrument = (env.PT_INSTRUMENT || 'ETH').toUpperCase()
  if (instrument !== 'BTC' && instrument !== 'ETH') throw new Error('PT_INSTRUMENT must be BTC or ETH')
  const mode = (env.PT_STRATEGY || 'pair').toLowerCase()
  if (mode !== 'pair' && mode !== 'spread') throw new Error('PT_STRATEGY must be pair or spread')
  const cfg: StrategyConfig = {
    instrument,
    legNotionalUsd: num(env, 'PT_LEG_NOTIONAL_USD', 1000),
    leverage: num(env, 'PT_LEVERAGE', 25),
    resetMove: num(env, 'PT_RESET_MOVE', 0.005),
    maxPairs: num(env, 'PT_MAX_PAIRS', 1),
    minBustDistance: num(env, 'PT_MIN_BUST_DISTANCE', 0.003),
    queueGuardMove: num(env, 'PT_QUEUE_GUARD_MOVE', 0.03),
    maxDailyCostUsd: num(env, 'PT_MAX_DAILY_COST_USD', 15),
    tickMs: num(env, 'PT_TICK_MS', 2000),
    openWaitMs: num(env, 'PT_OPEN_WAIT_MS', 45_000),
    closeWaitMs: num(env, 'PT_CLOSE_WAIT_MS', 180_000),
    closeOnExit: env.PT_CLOSE_ON_EXIT !== '0',
    mode,
    restrikeMove: num(env, 'PT_RESTRIKE_MOVE', 0.001),
    takeMove: num(env, 'PT_TAKE_MOVE', 0.004),
  }
  if (!Number.isInteger(cfg.leverage) || cfg.leverage < 1) throw new Error('PT_LEVERAGE must be a positive integer')
  if (!Number.isInteger(cfg.maxPairs) || cfg.maxPairs < 1) throw new Error('PT_MAX_PAIRS must be a positive integer')
  if (cfg.legNotionalUsd < MIN_NOTIONAL_USD) throw new Error(`PT_LEG_NOTIONAL_USD must be at least ${MIN_NOTIONAL_USD}`)
  if (cfg.legNotionalUsd / cfg.leverage < MIN_MARGIN_USD) {
    throw new Error(`margin per leg (notional / leverage) must be at least $${MIN_MARGIN_USD}`)
  }
  if (cfg.resetMove <= 0 || cfg.minBustDistance <= 0) throw new Error('PT_RESET_MOVE and PT_MIN_BUST_DISTANCE must be > 0')
  if (cfg.restrikeMove <= 0 || cfg.takeMove <= 0) throw new Error('PT_RESTRIKE_MOVE and PT_TAKE_MOVE must be > 0')
  return cfg
}

/**
 * Furthest a leg is expected to run against its entry before the strategy acts. In spread mode a restrike can be
 * held back (no room to reopen), and then the loser runs until the other leg reaches the take move.
 */
export const maxAdverseMove = (cfg: StrategyConfig) => (cfg.mode === 'spread' ? Math.max(cfg.restrikeMove, cfg.takeMove) : cfg.resetMove)

/** Bust distance left when a leg is as far against entry as the strategy lets it run; must stay above minBustDistance. */
export function bustSlack(cfg: StrategyConfig, bustBuffer: number): number {
  return 1 / cfg.leverage - bustBuffer - maxAdverseMove(cfg)
}

/** Per-leg margin in 18-dec USD, rounded up to whole USDC micro-units so notional never lands below the minimum. */
export function legMarginRaw(cfg: StrategyConfig): bigint {
  const micro = BigInt(Math.ceil((cfg.legNotionalUsd / cfg.leverage) * 1e6))
  return micro * USDC_UNIT
}

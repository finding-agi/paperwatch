import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zeroAddress, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { AccountStream } from './account.ts'
import { RelayerError, getProtocolSummary, getTradingState, relayerHealth, submitIntent } from './api.ts'
import { INTENT_TTL_SEC, loadStrategyConfig } from './config.ts'
import { EXCHANGE_DOMAIN, deadlineFromNow, signIntent } from './eip712.ts'
import { LiveExecutor } from './executor.ts'
import { impactParams, mintRate, pairCycle, winKeep } from './fees.ts'
import { readBbo } from './market.ts'
import { netExposureUsd, queueTriggerMove, sideHeadroomUsd } from './risk.ts'
import { makeClient, pct, price, requireWalletAddress, runBot, usd } from './bot.ts'
import { runBacktest, runRestrikeBacktest } from './backtest.ts'
import { runVol } from './vol.ts'
import { runWatcher } from './watcher.ts'
import { runIntakeMonitor } from './intake.ts'
import { runQueueView } from './queue-viz.ts'
import { runOpener } from './opener.ts'
import { runTrigger } from './trigger.ts'
import { awsKms, newKeyPair, newKmsKeyPair } from './keyring.ts'
import { NonceSource, createSessionKey, loadSessionKey, loadState, saveState } from './state.ts'

const M = (x: number) => `${usd(x / 1e6, 2)}M`

async function status(): Promise<void> {
  const cfg = loadStrategyConfig()
  const client = makeClient()
  const [trading, summary, health] = await Promise.all([
    getTradingState(),
    getProtocolSummary(),
    relayerHealth().catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
  ])
  const markets = await Promise.all(trading.instruments.map(async (inst) => ({ inst, bbo: await readBbo(client, inst.assetIndex) })))
  const trigger = queueTriggerMove(summary.lpUsd, markets.map((m) => ({ inst: m.inst, midRaw: m.bbo.mid })))
  const rate = mintRate(summary)
  const healthy = !(health instanceof Error) && health.ok && health.ready

  console.log('Protocol')
  console.log(`  relayer        ${healthy ? 'ok' : 'health endpoint unavailable'} | indexed through block ${trading.indexedThroughBlock}${trading.tradingPaused ? ' | TRADING PAUSED' : ''}`)
  console.log(`  LP             ${M(summary.lpUsd)} (staker cap ${M(summary.capUsd)}) | queue ${M(summary.queueUsd)}`)
  console.log(`  queue trigger  ~${pct(trigger, 1)} move against the LP would start queueing wins`)
  console.log(`  mint rate      ${rate.toFixed(2)} PAPER/$ (tail progress ${M(summary.tailProgressUsd)}; flat ${summary.flatRate}/$ below ${M(summary.cliffUsd)} tracked LP)`)
  console.log(`  PAPER          ${(summary.paperSupply / 1e9).toFixed(3)}B supply, ${pct(summary.paperStaked / summary.paperSupply, 1)} staked`)

  console.log('\nMarkets')
  for (const { inst, bbo } of markets) {
    const spreadBp = (Number(bbo.ask - bbo.bid) / Number(bbo.mid)) * 1e4
    const longUsd = (Number(inst.longOiRaw) / 1e18) * (Number(bbo.mid) / Number(inst.priceScale))
    const shortUsd = (Number(inst.shortOiRaw) / 1e18) * (Number(bbo.mid) / Number(inst.priceScale))
    const roomL = sideHeadroomUsd(inst, true, trading.maxNetOpenInterestRaw, bbo.mid)
    const roomS = sideHeadroomUsd(inst, false, trading.maxNetOpenInterestRaw, bbo.mid)
    console.log(
      `  ${inst.symbol.padEnd(4)} mid ${price(bbo.mid, inst)} (spread ${spreadBp.toFixed(2)}bp) | OI L ${M(longUsd)} / S ${M(shortUsd)} ` +
        `(net ${M(netExposureUsd(inst, bbo.mid))}) | room L ${M(roomL)} / S ${M(roomS)}${inst.openable ? '' : ' | NOT OPENABLE'}`,
    )
  }

  const home = trading.instruments.find((i) => i.symbol === cfg.instrument)!
  const impact = impactParams(home)
  const buffer = Number(home.bustBufferRaw) / 1e18
  console.log(`\nPair economics, ${home.symbol} at ${rate.toFixed(2)} PAPER/$ (haircut paid on the winning leg)`)
  console.log('  reset move   win kept   cost/loss   $/PAPER    max leverage')
  for (const move of [0.0025, 0.005, 0.01, 0.02]) {
    const c = pairCycle(move, impact, rate)
    const maxLev = Math.floor(1 / (move + buffer + cfg.minBustDistance))
    const mark = move === cfg.resetMove ? '  <- configured' : ''
    console.log(
      `  ${pct(move).padStart(9)}   ${pct(winKeep(move, impact), 1).padStart(8)}   ${pct(c.costPerLossUsd, 1).padStart(9)}   ${usd(c.costPerPaper, 4).padStart(8)}   ${String(maxLev).padStart(6)}x${mark}`,
    )
  }

  const wallet = process.env.PT_WALLET_ADDRESS
  if (!wallet) return
  const stream = new AccountStream(wallet)
  stream.start()
  try {
    const acct = await stream.ready()
    const key = loadSessionKey()
    console.log(`\nAccount ${acct.address}`)
    console.log(`  balance ${usd(Number(acct.balance) / 1e18)} (available ${usd(Number(acct.availableBalance) / 1e18)}, in margin ${usd(Number(acct.locked) / 1e18)}, queued ${usd(Number(acct.queued) / 1e18)})`)
    console.log(`  PAPER   ${(Number(acct.paperStaked) / 1e18).toFixed(0)} staked, ${(Number(acct.paperBalance) / 1e18).toFixed(0)} unstaked`)
    console.log(`  open    ${acct.positions.size} position(s), ${acct.pendingIntents.size} pending intent(s)`)
    for (const [k, exp] of acct.sessionKeys) {
      const ours = key?.address.toLowerCase() === k ? ' (this bot)' : ''
      console.log(`  session ${k} until ${new Date(Number(exp) * 1000).toISOString()}${ours}`)
    }
    if (key && !acct.sessionKeys.has(key.address.toLowerCase())) console.log('  bot session key is not registered; run `npm run session`')
  } finally {
    stream.stop()
  }
}

async function session(): Promise<void> {
  const pk = process.env.PT_WALLET_PRIVATE_KEY as Hex | undefined
  if (!pk) throw new Error('set PT_WALLET_PRIVATE_KEY in .env (only this command needs it)')
  const wallet = privateKeyToAccount(pk)
  const configured = process.env.PT_WALLET_ADDRESS
  if (configured && configured.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('PT_WALLET_PRIVATE_KEY does not match PT_WALLET_ADDRESS')
  }
  const stream = new AccountStream(wallet.address)
  stream.start()
  try {
    const acct = await stream.ready()
    const nowSec = Math.floor(Date.now() / 1000)
    const minLeftSec = 3 * 86_400
    let key = loadSessionKey()
    const sameWallet = key?.wallet.toLowerCase() === wallet.address.toLowerCase()
    const registered = key && sameWallet ? acct.sessionKeys.get(key.address.toLowerCase()) : undefined
    if (key && registered && Number(registered) > nowSec + minLeftSec) {
      console.log(`session key ${key.address} already registered until ${new Date(Number(registered) * 1000).toISOString()}`)
      return
    }
    if (!key || !sameWallet || Number(key.expiry) < nowSec + minLeftSec) key = createSessionKey(wallet.address)

    const state = loadState('live')
    const nonces = new NonceSource(state, () => saveState('live', state))
    await nonces.ensureUnused(makeClient(), wallet.address)
    const { signed, intentId } = await signIntent(wallet, EXCHANGE_DOMAIN, 'RegisterSessionKey', {
      user: wallet.address,
      key: key.address,
      expiry: BigInt(key.expiry),
      feeAddress: zeroAddress, // what the official frontend sends
      nonce: nonces.take(),
      deadline: deadlineFromNow(INTENT_TTL_SEC),
    })
    try {
      await submitIntent('registerSessionKey', signed, intentId)
    } catch (err) {
      if (err instanceof RelayerError && err.reason === 'noDeposit') {
        throw new Error('the relayer wants a deposit on this account first; deposit at least 10 USDC through papertrade.xyz')
      }
      throw err
    }
    const address = key.address.toLowerCase()
    console.log(`submitted registration for ${key.address}; waiting for it to land…`)
    await stream.waitFor((s) => (s.sessionKeys.has(address) ? true : undefined), 90_000)
    console.log(`registered ${key.address}, valid until ${new Date(Number(key.expiry) * 1000).toISOString()}`)
  } finally {
    stream.stop()
  }
}

async function closeAll(): Promise<void> {
  const wallet = requireWalletAddress()
  const key = loadSessionKey()
  if (!key || key.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('no session key for this wallet; run `npm run session`')
  const stream = new AccountStream(wallet)
  stream.start()
  try {
    const acct = await stream.ready()
    const ids = [...acct.positions.keys()]
    if (!ids.length) {
      console.log('no open positions')
      return
    }
    const state = loadState('live')
    const nonces = new NonceSource(state, () => saveState('live', state))
    await nonces.ensureUnused(makeClient(), wallet)
    const executor = new LiveExecutor(wallet, privateKeyToAccount(key.privateKey), stream, nonces)
    await executor.submitClose(ids)
    console.log(`submitted close for ${ids.length} position(s); waiting…`)
    await stream
      .waitFor((s) => (ids.every((id) => !s.positions.has(id)) ? true : undefined), 120_000)
      .then(() => console.log('all closed'))
      .catch(() => console.log('some positions are still open; check the app'))
  } finally {
    stream.stop()
  }
}

const HELP = `usage: npm run <command>

  status      protocol, market and account overview, plus pair economics for your config
  session     register a 30-day trading key for PT_WALLET_ADDRESS (needs PT_WALLET_PRIVATE_KEY once)
  dry         run the strategy against live prices without submitting anything
  live        run the strategy for real (submits intents through Papertrade's relayer)
  watch       separate safety process for the live bot: alerts, and closes its legs if the bot dies
  backtest    replay the pair strategy on recent 1m candles at several reset sizes (--days=N, default 7)
  restrike    replay the restrike plan (close the losing leg at X, take at T) over a grid of X and T (--days=N, default 3.4)
  vol         ETH volatility now and the leverage it implies (--eval scores the estimators; --horizon= --z= --min= --max=)
  intake      read-only monitor of relayer intake speed vs LP, OI and volatility (no keys, never trades)
  queue       live local view of the relayer's global queue and per-block gas at http://localhost:8787 (no keys)
  opener      open ONE long + short pair now (--live to send), then do nothing: never closes or resets
  trigger     page at http://localhost:8788 for opens that fire when Hyperliquid's mid crosses your price (--live to send)
  close-all   close EVERY open position on the account, including ones the bot didn't open
  keys <dir>  new trading-key seal pair: prints PT_KEY_PUBLIC, writes the private half to <dir> (--kms alias/x: KMS-encrypted)

Config lives in .env (see .env.example).`

const [cmd, ...args] = process.argv.slice(2)

/**
 * A seal key pair for trading keys. The private half goes to a file (owner-only), never to the terminal; with
 * --kms <key id or alias> it is encrypted by AWS KMS first (your local AWS login), so it never touches disk in the clear.
 */
async function newTradingKeyPair(argv: string[]): Promise<void> {
  const kmsAt = argv.indexOf('--kms')
  const kmsKey = kmsAt >= 0 ? argv[kmsAt + 1] : undefined
  const dir = kmsAt >= 0 ? argv.filter((_, i) => i !== kmsAt && i !== kmsAt + 1)[0] : argv[0]
  if (!dir || (kmsAt >= 0 && !kmsKey)) throw new Error('usage: npm run keys -- [--kms alias/<name>] <dir>')
  mkdirSync(dir, { recursive: true })
  if (kmsKey) {
    const { kid, publicKey, privateKms } = await newKmsKeyPair(await awsKms(), kmsKey)
    const file = join(dir, `trading-key-${kid}.kms`)
    writeFileSync(file, privateKms, { mode: 0o600, flag: 'wx' })
    console.log(`kid ${kid}\nPT_KEY_PUBLIC=${publicKey}\nPT_KEY_PRIVATE_KMS (KMS-encrypted) is in ${file}: set it on the worker only`)
    return
  }
  const { kid, publicKey, privateKey } = newKeyPair()
  const file = join(dir, `trading-key-${kid}.private`)
  writeFileSync(file, privateKey, { mode: 0o600, flag: 'wx' })
  console.log(`kid ${kid}\nPT_KEY_PUBLIC=${publicKey}\nPT_KEY_PRIVATE is in ${file} (set it on the worker only, then delete the file)`)
}

const commands: Record<string, () => Promise<void>> = {
  status,
  session,
  run: () => runBot({ live: args.includes('--live') }),
  'close-all': closeAll,
  watch: runWatcher,
  intake: runIntakeMonitor,
  queue: runQueueView,
  opener: () => runOpener({ live: args.includes('--live') }),
  trigger: () => runTrigger({ live: args.includes('--live') }),
  backtest: () => runBacktest(args),
  restrike: () => runRestrikeBacktest(args),
  vol: () => runVol(args),
  keys: () => newTradingKeyPair(args),
}

const fn = cmd ? commands[cmd] : undefined
if (!fn) {
  console.log(HELP)
  process.exit(cmd && cmd !== 'help' ? 1 : 0)
}
fn()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })

import { decodeAbiParameters, encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from 'viem'
import { CONTRACTS } from './config.ts'
import type { BotState } from './state.ts'

const MULTISIG_ABI = [
  { type: 'function', name: 'transactionCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transactions', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [] },
] as const

const USDC: Address = '0xb88339CB7199b77E23DB6E890353E22632Ba630f'
const PROXY_ADMIN: Address = '0xe79c91cc682f1bb401a9cab74c900470190f0f8f'
const ERC20_TRANSFER = '0xa9059cbb'
// Anything the multisig sends to these can change how the protocol behaves.
const PROTOCOL = new Set([...Object.values(CONTRACTS), PROXY_ADMIN].map((a) => getAddress(a)))

const MAX_LOG_RANGE = 500n // public HyperEVM RPC rejects eth_getLogs over ~1000 blocks ("Request exceeds defined limit"); 500 leaves headroom
const MAX_BACKFILL = 10_000n // older gaps are still caught by the multisig counter
const MAX_CHUNKS_PER_CHECK = 3
const CHUNK_PAUSE_MS = 400
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type AdminAlert = { message: string; pause: boolean }

/**
 * Every owner action goes multisig -> Timelock (7-day delay) -> contracts. Multisig transactions aimed at the
 * protocol (or anything we can't classify) and any Timelock event pause new opens; the multisig paying out USDC from
 * its own wallet is reported but doesn't.
 */
export class AdminWatcher {
  readonly #client: PublicClient
  readonly #admin: BotState['admin']

  constructor(client: PublicClient, admin: BotState['admin']) {
    this.#client = client
    this.#admin = admin
  }

  async #describeMultisigTx(id: number): Promise<AdminAlert> {
    try {
      // The custom multisig's getter isn't in any public ABI; layout read from on-chain returns.
      const { data } = await this.#client.call({
        to: CONTRACTS.multisig,
        data: encodeFunctionData({ abi: MULTISIG_ABI, functionName: 'transactions', args: [BigInt(id)] }),
      })
      const [to, , callData] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint8' }],
        data as Hex,
      )
      const target = getAddress(to)
      if (target === getAddress(USDC) && callData.startsWith(ERC20_TRANSFER)) {
        const [recipient, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], `0x${callData.slice(10)}`)
        return { message: `multisig tx #${id}: pays ${(Number(amount) / 1e6).toFixed(2)} USDC from its own wallet to ${recipient}`, pause: false }
      }
      const why = PROTOCOL.has(target) ? 'targets a protocol contract' : 'unrecognised target'
      return { message: `multisig tx #${id} ${why} (${target}, selector ${callData.slice(0, 10)})`, pause: true }
    } catch (err) {
      return { message: `multisig tx #${id} could not be decoded (${err instanceof Error ? err.message.split('\n')[0] : err})`, pause: true }
    }
  }

  async check(): Promise<AdminAlert[]> {
    const alerts: AdminAlert[] = []
    const count = Number(
      await this.#client.readContract({ address: CONTRACTS.multisig, abi: MULTISIG_ABI, functionName: 'transactionCount' }),
    )
    const seen = this.#admin.multisigTxCount
    if (seen !== undefined) for (let id = seen; id < count; id++) alerts.push(await this.#describeMultisigTx(id))
    this.#admin.multisigTxCount = count

    // Catch up a few chunks per check, saving progress after each, so a long gap (bot stopped, dry mode) doesn't
    // hit the public RPC's burst limit ("Request exceeds defined limit") and fail the same way every minute.
    const head = await this.#client.getBlockNumber()
    let from = this.#admin.timelockBlock !== undefined ? BigInt(this.#admin.timelockBlock) + 1n : head - (MAX_LOG_RANGE - 1n)
    if (head - from > MAX_BACKFILL) from = head - MAX_BACKFILL
    let chunks = 0
    for (let start = from; start <= head && chunks < MAX_CHUNKS_PER_CHECK; start += MAX_LOG_RANGE, chunks++) {
      if (chunks > 0) await sleep(CHUNK_PAUSE_MS)
      const end = start + MAX_LOG_RANGE - 1n < head ? start + MAX_LOG_RANGE - 1n : head
      const logs = await this.#client.getLogs({ address: CONTRACTS.timelock, fromBlock: start, toBlock: end })
      for (const log of logs) {
        alerts.push({ message: `timelock event ${log.topics[0]} in tx ${log.transactionHash} (block ${log.blockNumber})`, pause: true })
      }
      this.#admin.timelockBlock = Number(end)
    }
    return alerts
  }
}

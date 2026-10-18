import {
  concat,
  hashTypedData,
  keccak256,
  parseSignature,
  recoverAddress,
  toBytes,
  type Hex,
  type LocalAccount,
  type TypedDataDomain,
} from 'viem'
import { CHAIN_ID, CONTRACTS } from './config.ts'

// Copied from the papertrade.xyz frontend. OPEN_POSITION_TYPEHASH and CLOSE_TYPEHASH match SessionKeyManager on-chain.
export const INTENT_TYPES = {
  RegisterSessionKey: [
    { name: 'user', type: 'address' },
    { name: 'key', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'feeAddress', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  OpenPosition: [
    { name: 'user', type: 'address' },
    { name: 'instrumentId', type: 'uint32' },
    { name: 'isLong', type: 'bool' },
    { name: 'size', type: 'uint128' },
    { name: 'leverage', type: 'uint32' },
    { name: 'useDebt', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  Close: [
    { name: 'user', type: 'address' },
    { name: 'positionIds', type: 'uint256[]' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
  ],
  CancelIntent: [
    { name: 'user', type: 'address' },
    { name: 'intentId', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type IntentType = keyof typeof INTENT_TYPES

// The Exchange's EIP-712 name really is "String" (checked against SessionKeyManager.DOMAIN_SEPARATOR()).
export const EXCHANGE_DOMAIN = {
  name: 'String',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: CONTRACTS.exchange,
} as const satisfies TypedDataDomain

export const CANCEL_DOMAIN = {
  name: 'PaperTrade Intent Cancel',
  version: '2',
  chainId: CHAIN_ID,
  verifyingContract: CONTRACTS.exchange,
} as const satisfies TypedDataDomain

const INTENT_ID_TAG = keccak256(toBytes('papertrade:intent-id:v2'))

export type WireValue = string | boolean | string[]
export type SignedIntent = Record<string, WireValue> & { v: string; r: Hex; s: Hex }

// Same wire encoding as the frontend: uints as decimal strings, addresses and bytes lowercase.
function toWire(type: string, value: unknown): WireValue {
  if (type === 'uint256[]') return (value as Array<bigint | number | string>).map((v) => BigInt(v).toString())
  if (type.startsWith('uint')) return BigInt(value as bigint | number | string).toString()
  if (type === 'address' || type.startsWith('bytes')) return (value as string).toLowerCase()
  return value as boolean
}

function typedFor(domain: TypedDataDomain, primaryType: IntentType, input: Record<string, unknown>) {
  // viem rejects mixed-case addresses that aren't checksummed; lowercase hashes identically.
  const message = { ...input }
  for (const { name, type } of INTENT_TYPES[primaryType]) {
    if (type === 'address') message[name] = (input[name] as string).toLowerCase()
  }
  return {
    domain,
    types: { [primaryType]: INTENT_TYPES[primaryType] },
    primaryType,
    message,
  } as unknown as Parameters<typeof hashTypedData>[0]
}

export async function signIntent(
  signer: LocalAccount,
  domain: TypedDataDomain,
  primaryType: IntentType,
  input: Record<string, unknown>,
): Promise<{ signed: SignedIntent; intentId: Hex; signer: Hex }> {
  return intentFromSignature(domain, primaryType, input, await signer.signTypedData(typedFor(domain, primaryType, input)))
}

/** Wire format and intent id for an intent someone else signed (e.g. a browser wallet), plus who signed it. */
export async function intentFromSignature(
  domain: TypedDataDomain,
  primaryType: IntentType,
  input: Record<string, unknown>,
  signature: Hex,
): Promise<{ signed: SignedIntent; intentId: Hex; signer: Hex }> {
  const typed = typedFor(domain, primaryType, input)
  const message = typed.message as Record<string, unknown>
  const digest = hashTypedData(typed)
  const recovered = (await recoverAddress({ hash: digest, signature })).toLowerCase() as Hex
  const { r, s, yParity } = parseSignature(signature)
  const fields: Record<string, WireValue> = {}
  for (const { name, type } of INTENT_TYPES[primaryType]) fields[name] = toWire(type, message[name])
  return {
    signed: { ...fields, v: String(27 + (yParity ?? 0)), r: r.toLowerCase() as Hex, s: s.toLowerCase() as Hex },
    intentId: keccak256(concat([INTENT_ID_TAG, digest, recovered])),
    signer: recovered,
  }
}

/** The typed data a browser wallet signs with eth_signTypedData_v4 (uints as decimal strings). */
export function walletTypedData(domain: TypedDataDomain, primaryType: IntentType, input: Record<string, unknown>) {
  const message: Record<string, WireValue> = {}
  for (const { name, type } of INTENT_TYPES[primaryType]) message[name] = toWire(type, input[name])
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      [primaryType]: INTENT_TYPES[primaryType],
    },
    domain,
    primaryType,
    message,
  }
}

export const deadlineFromNow = (ttlSec: bigint, nowMs = Date.now()) => BigInt(Math.floor(nowMs / 1000)) + ttlSec

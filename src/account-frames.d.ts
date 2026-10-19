import type { AccountState, FrameResult, Position } from './account.ts'

export declare class OutOfSyncError extends Error {}
export declare function parsePosition(t: unknown[]): Position
export declare function applyFrame(prev: AccountState | null, frame: Record<string, any>): FrameResult

export type KeyInfo = { address: string; expiry: number; submittedAt?: number; registeredAt?: number }
export type KeyStatus =
  | { status: 'none' }
  | { status: 'active' | 'pending'; key: string; expiry: number }
export declare function keyStatus(key: KeyInfo | undefined, sessionKeys: Map<string, bigint> | undefined, live: boolean, now?: number): KeyStatus

export type BoxMarket = { id: number; symbol: string; priceScale: string | number; mid: number | null }
export type BoxClose = { positionId: string; done: boolean; error: string | null; at: number }
export declare function accountBox(s: AccountState, markets: BoxMarket[], closes?: BoxClose[], stakingContract?: string | null, now?: number): Record<string, any>

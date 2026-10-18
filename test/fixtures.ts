import { parseInstrument } from '../src/api.ts'

// BTC instrument tuple from /state/trading on 2026-10-13 (BBO mid 82789.5 at the time).
export const BTC = parseInstrument([
  0, 'BTC', 0, '10', true, false, false, false, false, null, null, null,
  '15000000000000000000000', '814598000000000000000', 1000, '10000000000000000000000000', '476041580087574',
  '100000000000000000', '100000000000000000000000',
  '1312814825303578613182', '792903383888640845388', '1373279069772611850377', '853761696168427524418',
])
export const BTC_MID = 827895n
export const MAX_NET_OI = 40_000_000n * 10n ** 18n

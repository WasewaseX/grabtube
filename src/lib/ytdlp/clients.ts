/**
 * Player-client rotation: default client + PO tokens yields the FULL format
 * map; fallbacks cover tunnel phases where it bot-walls or degrades.
 */
const CLIENT_ORDER = ['default', 'tv_embedded', 'web_embedded', 'mweb']

/** A client result must carry at least this many media formats to count as
 *  healthy. Degraded single-format responses (mweb/android) are only accepted
 *  after every healthier step failed. */
export const MIN_HEALTHY_FORMATS = 3

/** Rotation steps; [0] is used by server-side jobs (jobs.ts) so it must always
 *  carry the freshest visitor_data. Mutated in place by refreshClientChain.
 *  The 'default' step is an EMPTY arg list — no player_client override. */
export const CLIENT_CHAIN: string[][] = CLIENT_ORDER.map((c) =>
  c === 'default' ? [] : ['--extractor-args', `youtube:player_client=${c}`],
)

export function refreshClientChain(visitorData: string | null): void {
  for (let i = 0; i < CLIENT_ORDER.length; i++) {
    if (CLIENT_ORDER[i] === 'default') {
      CLIENT_CHAIN[i] = []
      continue
    }
    const val = visitorData
      ? `youtube:player_client=${CLIENT_ORDER[i]};visitor_data=${visitorData}`
      : `youtube:player_client=${CLIENT_ORDER[i]}`
    CLIENT_CHAIN[i] = ['--extractor-args', val]
  }
}

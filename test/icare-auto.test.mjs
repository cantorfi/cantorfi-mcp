// Agent autonome : lecture des options, bilan des streamers, règle intégrée, réponse du cerveau et limites du propriétaire.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS, checkSettings, guard, parseArgs, parseDecision, rulesDecision, spentLast24h, takeProfitReached } from '../src/apps/icare-auto.mjs'
import { playerRecord } from '../src/apps/icare.mjs'

const row = (id, player, game, result, startedAtMs) => ({ matchId: String(id), cancelled: result === 'refunded', winnerSide: result === 'Win' ? 1 : result === 'Lose' ? 2 : null,
  observed: { playerName: player, gameAppId: game, result: result === 'refunded' ? null : result, startedAtMs } })
const cfg = { minStake: '1000000', maxStake: '50000000' }
const settings = checkSettings({ ...DEFAULTS, stake: 2, maxStake: 5, daily: 10, maxOpen: 2 })

test('options are parsed, typed and checked', () => {
  assert.deepEqual(parseArgs(['run', '--brain', 'claude', '--max-stake', '4', '--strategy', 'only bet on Valorant']),
    { command: 'run', flags: { brain: 'claude', maxStake: 4, strategy: 'only bet on Valorant' } })
  assert.equal(parseArgs([]).command, 'status')
  assert.throws(() => parseArgs(['run', '--budget', '3']), /Unknown option --budget/)
  assert.throws(() => parseArgs(['run', '--stake', 'abc']), /--stake must be a number/)
  assert.throws(() => parseArgs(['trade']), /Unknown command/)
  assert.throws(() => checkSettings({ ...DEFAULTS, brain: 'command' }), /--brain-cmd/)
  assert.throws(() => checkSettings({ ...DEFAULTS, stake: 3, daily: 3 }), /--daily/)
})

test('streamer record counts only this player and game, newest first', () => {
  const rows = [row(1, 'eggsterr', 'valorant', 'Win', 1), row(2, 'eggsterr', 'valorant', 'Lose', 3), row(3, 'eggsterr', 'valorant', 'refunded', 4),
    row(4, 'eggsterr', 'cs2', 'Win', 5), row(5, 'MaatM', 'valorant', 'Win', 6), row(6, 'eggsterr', 'valorant', 'Win', 2)]
  assert.deepEqual(playerRecord(rows, 'eggsterr', 'valorant'), { settled: 3, wins: 2, losses: 1, refunded: 1, lastResults: ['Lose', 'Win', 'Win'] })
})

test('the built-in rule bets only when the record beats the price by the edge', () => {
  const record = { settled: 8, wins: 7, losses: 1, refunded: 0, lastResults: [] }
  const match = { player: 'eggsterr', winPrice: 0.55, losePrice: 0.45 }
  assert.equal(rulesDecision({ match, record }, 0.1).side, 'win')
  assert.equal(rulesDecision({ match: { ...match, winPrice: 0.85, losePrice: 0.15 }, record }, 0.1).bet, false)
  assert.equal(rulesDecision({ match, record: { ...record, wins: 1, losses: 7 } }, 0.1).side, 'lose')
  assert.match(rulesDecision({ match, record: { ...record, settled: 2 } }, 0.1).reason, /only 2 settled games/)
  assert.match(rulesDecision({ match: { ...match, winPrice: undefined }, record }, 0.1).reason, /no market price/)
})

test('the brain answer is read even when wrapped in text', () => {
  assert.deepEqual(parseDecision('Sure.\n{"bet": true, "side": "lose", "stakeUsdc": 3, "reason": "cold streak"}'), { bet: true, side: 'lose', stakeUsdc: 3, reason: 'cold streak' })
  assert.deepEqual(parseDecision('{"bet": false, "reason": "no edge"}'), { bet: false, reason: 'no edge' })
  assert.throws(() => parseDecision('{"bet": true, "side": "draw"}'), /win" or "lose/)
  assert.throws(() => parseDecision('I would skip this one'), /no JSON decision/)
})

test('owner limits apply whatever the brain decides', () => {
  const now = 1_000_000_000_000, closesAt = now / 1000 + 300
  assert.deepEqual(guard({ bet: true, side: 'win', stakeUsdc: 40 }, { settings, cfg, bets: [], now, closesAt }), { ok: true, stake: 5 })
  assert.deepEqual(guard({ bet: true, side: 'win', stakeUsdc: 0.2 }, { settings, cfg, bets: [], now, closesAt }), { ok: true, stake: 1 })
  assert.deepEqual(guard({ bet: true, side: 'win', stakeUsdc: null }, { settings, cfg, bets: [], now, closesAt }), { ok: true, stake: 2 })
  const open = [{ stake: 1, at: now }, { stake: 1, at: now }]
  assert.match(guard({ bet: true, side: 'win' }, { settings, cfg, bets: open, now, closesAt }).reason, /2 positions already open/)
  const spent = [{ stake: 4, at: now - 1000, outcome: 'lost' }, { stake: 3, at: now - 2000, outcome: 'won' }, { stake: 9, at: now - 90_000_000, outcome: 'lost' }]
  assert.equal(Math.round(spentLast24h(spent, now) * 100) / 100, 7.4)
  assert.match(guard({ bet: true, side: 'win', stakeUsdc: 5 }, { settings, cfg, bets: spent, now, closesAt }).reason, /daily limit/)
  assert.match(guard({ bet: true, side: 'win' }, { settings, cfg, bets: [], now, closesAt: now / 1000 + 10 }).reason, /less than 20 s/)
  assert.equal(guard({ bet: false, reason: 'no edge' }, { settings, cfg, bets: [], now, closesAt }).ok, false)
})

test('profit is taken only at the owner target', () => {
  assert.equal(takeProfitReached({ stake: 2 }, 2.6, 0.3), true)
  assert.equal(takeProfitReached({ stake: 2 }, 2.5, 0.3), false)
  assert.equal(takeProfitReached({ stake: 2 }, 9, 0), false)
})

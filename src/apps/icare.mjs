// ICARE, an application built on CantorFi: followed matches, Win / Lose stake paid from the ICARE Portfolio or with
// x402 (no gas, no ETH), positions, resale to the ICARE liquidity and Season 0. Wallet, state and x402 payment are
// the single agent's own: this module only knows what is specific to ICARE.
import { ethers } from 'ethers'
import { KEY_KEPT_IN, agentWallet, readState, saveState as saveAgentState } from '../agent/state.mjs'
import { payX402 } from '../agent/x402.mjs'

export const API = (process.env.ICARE_API_URL || 'https://api.icarehub.xyz').replace(/\/+$/, '')
export const APP = (process.env.ICARE_APP_URL || 'https://app.icarehub.xyz').replace(/\/+$/, '')
const SEASON = process.env.ICARE_SEASON_URL || 'https://superdash-api.icarehub.xyz/api/indexed/icare/season0'
const RPC = process.env.ICARE_RPC_URL || 'https://sepolia.base.org'
export const DISCORD = 'https://discord.gg/SmRynyJmnK'
const provider = new ethers.JsonRpcProvider(RPC)
let wallet = null
const MATCH_ABI = ['function marketId(uint256) view returns(bytes32)', 'function predictionFor(uint256) view returns(address)',
  'function predictionLifecycle(uint256) view returns(uint8)',
  'function placePrediction(uint256,uint8,uint256)']
const FUNDS_ABI = ['function executionNonce(address) view returns(uint256)', 'function balanceOf(address) view returns(uint256)',
  'function actionDigest((address account,address target,uint256 value,uint256 relayFee,uint256 nonce,uint64 deadline,bytes data)) view returns(bytes32)']
const PREDICTION_ABI = ['function positionsOf(bytes32,address) view returns(uint256[4])',
  'function quoteTransferFees(bytes32,uint256) view returns(uint256 appFee,uint256 protocolFee,uint256 sellerProceeds)',
  'function claimable(bytes32,address) view returns(uint256)', 'function claimed(bytes32,address) view returns(bool)',
  'event Claimed(bytes32 indexed questionId, address indexed beneficiary, uint256 payout)']
// Le RPC public de Base Sepolia limite eth_getLogs à 200 blocs par requête.
const LOG_RANGE = 200
const OFFER_TYPES = { PositionOffer: [{ name: 'questionId', type: 'bytes32' }, { name: 'seller', type: 'address' }, { name: 'outcome', type: 'uint8' },
  { name: 'units', type: 'uint256' }, { name: 'price', type: 'uint256' }, { name: 'minSellerProceeds', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] }

export const usdc = units => ethers.formatUnits(units, 6)
// Refus attendu (mise hors limites, partie fermée…) : le message est rendu tel quel à l'agent.
export class IcareError extends Error {}

// The wallet is the single agent's wallet, connected to the ICARE network.
let walletPromise = null
export const ensureWallet = () => walletPromise ||= (async () => {
  wallet = await agentWallet(provider)
  return wallet
})().catch(error => { walletPromise = null; throw error })
// Un pari payé en x402 enchaîne trois transactions confirmées côté ICARE (encaissement, crédit, relais) : ~40 s.
async function json(url, init = {}, timeoutMs = 30_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const body = await response.json().catch(() => null)
  return { status: response.status, headers: response.headers, body }
}
// ICARE keeps its own entries under "icare" in the agent's state file.
async function state() { return (await readState()).icare || {} }
async function saveState(next) { await saveAgentState({ ...(await readState()), icare: next }) }
let configPromise = null
export const config = () => (configPromise ||= json(`${API}/api/agents/config`).then(({ status, body }) => {
  if (status !== 200 || !body?.match) { configPromise = null; throw new IcareError('ICARE agent API unavailable, retry later.') }
  return body
}))
async function accessSession() {
  const saved = (await state())[wallet.address.toLowerCase()]?.access
  const value = process.env.ICARE_ACCESS_SESSION || saved
  if (!value) throw new IcareError(`This wallet is not activated. Get an access code in the ICARE Discord (${DISCORD}) and run: cantorfi-agent icare activate <code>.`)
  return value
}
export function summary(row) {
  const prices = (row.marketPrices || []).map(value => Number(BigInt(value) * 10_000n / 10n ** 18n) / 10_000)
  const observed = row.observed || {}
  const status = row.cancelled ? 'refunded' : row.winnerSide != null ? 'settled' : observed.inProgress ? (Date.now() / 1000 < observed.closesAt ? 'open' : 'in_progress_closed') : 'verifying'
  return { matchId: row.matchId, player: observed.playerName, game: observed.gameAppId, status, closesAt: observed.closesAt ? new Date(observed.closesAt * 1000).toISOString() : null,
    winPrice: prices[0], losePrice: prices[1], potUsdc: usdc(row.marketVolume || '0'), result: observed.result || null,
    proof: observed.proofCid ? `${API}/ipfs/${observed.proofCid}` : null, stream: observed.streamUrl || null, page: `${APP}/en/arena/match/${row.matchId}` }
}
// Bilan du streamer sur ICARE pour ce jeu, parties les plus récentes d'abord.
export function playerRecord(rows, player, game) {
  const own = rows.filter(row => row.observed?.playerName === player && row.observed?.gameAppId === game)
    .sort((a, b) => (b.observed?.startedAtMs || 0) - (a.observed?.startedAtMs || 0))
  const settled = own.filter(row => !row.cancelled && row.winnerSide != null)
  const wins = settled.filter(row => row.observed?.result === 'Win').length
  return { settled: settled.length, wins, losses: settled.length - wins, refunded: own.filter(row => row.cancelled).length,
    lastResults: settled.slice(0, 10).map(row => row.observed.result) }
}

async function market(matchId) {
  const { match } = await config()
  const contract = new ethers.Contract(match, MATCH_ABI, provider)
  const [questionId, prediction] = await Promise.all([contract.marketId(matchId), contract.predictionFor(matchId)])
  return { questionId, prediction: new ethers.Contract(prediction, PREDICTION_ABI, provider), predictionAddress: prediction }
}

export async function walletInfo() {
  await ensureWallet()
  const cfg = await config()
  const token = new ethers.Contract(cfg.asset, ['function balanceOf(address) view returns(uint256)'], provider)
  const funds = new ethers.Contract(cfg.funds, FUNDS_ABI, provider)
  const [walletUsdc, portfolioUsdc] = await Promise.all([token.balanceOf(wallet.address), funds.balanceOf(wallet.address)])
  return { address: wallet.address, network: 'Base Sepolia testnet', walletUsdc: usdc(walletUsdc), portfolioUsdc: usdc(portfolioUsdc), ethNeeded: false,
    testUsdc: 'https://faucet.circle.com: choose Base Sepolia and paste the address', keyKeptIn: KEY_KEPT_IN }
}

// Stakes are accepted by the match contract only while its prediction lifecycle is "trading" (0). The published list
// can still call a match open for a few minutes after the contract closed it: the chain is the reference.
export async function betsOpenOnChain(matchId) {
  const { match } = await config()
  return Number(await new ethers.Contract(match, MATCH_ABI, provider).predictionLifecycle(BigInt(matchId))) === 0
}
// Open matches as the agent may act on them: published as open AND still accepting stakes on chain.
export async function openMatches() {
  const open = (await observedRows()).map(summary).filter(row => row.status === 'open')
  return Promise.all(open.map(async row => ({ ...row, betsOpen: await betsOpenOnChain(row.matchId).catch(() => false) })))
}

// Parties suivies brutes (en cours et récentes), telles que les publie l'Oracle.
export async function observedRows() {
  const { status, body } = await json(`${API}/api/observed`)
  if (status !== 200 || !Array.isArray(body)) throw new IcareError('ICARE match list unavailable, retry later.')
  return body
}

export async function activate(code) {
  await ensureWallet()
  const walletAddress = wallet.address.toLowerCase()
  const challenge = await json(`${APP}/api/early-access/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'activate', walletAddress, code }) })
  if (challenge.status !== 200 || !challenge.body?.message) throw new IcareError(`Activation refused (${challenge.body?.error || challenge.status}).`)
  const signature = await wallet.signMessage(challenge.body.message)
  const response = await fetch(`${APP}/api/invitation/verify`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, walletAddress, nonce: challenge.body.nonce, signature }), signal: AbortSignal.timeout(30_000) })
  const cookie = response.headers.getSetCookie().map(line => line.split(';')[0]).find(line => line.startsWith('icare-access-v1='))
  if (response.status !== 200 || !cookie) throw new IcareError(`Activation refused (${(await response.json().catch(() => ({}))).error || response.status}).`)
  const saved = await state()
  saved[walletAddress] = { ...(saved[walletAddress] || {}), access: cookie.slice('icare-access-v1='.length) }
  await saveState(saved)
  return { activated: true, wallet: walletAddress }
}

export async function placeBet({ matchId, side, stakeUsdc }) {
  await ensureWallet()
  const cfg = await config(), stake = ethers.parseUnits(stakeUsdc, 6), outcome = side === 'win' ? 0 : 1, account = wallet.address.toLowerCase()
  if (stake < BigInt(cfg.minStake) || stake > BigInt(cfg.maxStake)) throw new IcareError(`Stake must be between ${usdc(cfg.minStake)} and ${usdc(cfg.maxStake)} USDC.`)
  // Checked on chain before anything is signed or paid: a stake on a closed match would only land on the Portfolio.
  if (!await betsOpenOnChain(matchId)) throw new IcareError(`Match ${matchId} no longer accepts stakes: nothing was signed or paid.`)
  // Code d'accès désactivé côté ICARE (accessRequired: false) : aucune activation, le wallet signe la mise et le paiement.
  const access = cfg.accessRequired === false ? null : await accessSession()
  const funds = new ethers.Contract(cfg.funds, FUNDS_ABI, provider)
  const [nonce, balance, block] = await Promise.all([funds.executionNonce(account), funds.balanceOf(account), provider.getBlock('latest')])
  const action = { account, target: cfg.match, value: stake.toString(), relayFee: '0', nonce: nonce.toString(), deadline: String(Number(block.timestamp) + 600),
    data: new ethers.Interface(MATCH_ABI).encodeFunctionData('placePrediction', [BigInt(matchId), outcome, stake]) }
  const signature = await wallet.signMessage(ethers.getBytes(await funds.actionDigest(action)))
  if (BigInt(balance) >= stake + 100_000n) {
    const relayed = await json(`${API}/api/funds/execute-signed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, signature }) }, 90_000)
    if (relayed.status !== 200) throw new IcareError(`Bet refused (${relayed.body?.error || relayed.status}).`)
    return { placed: true, matchId, side, stakeUsdc, paidFrom: 'portfolio', betTx: relayed.body?.txHash }
  }
  // The ICARE desk asks for the stake plus its fees, paid to ICARE: the agent's x402 payer signs exactly that.
  const paid = await payX402({ url: `${API}/api/agents/bets`, headers: access ? { 'x-icare-access': access } : {},
    body: { matchId, outcome, stake: stake.toString(), action, signature }, wallet, provider,
    maxAtomic: stake + BigInt(cfg.fees), expect: { payTo: cfg.payTo, asset: cfg.asset, amount: stake + BigInt(cfg.fees) } })
  if (!paid.paid) {
    throw new IcareError(`Bet not placed (${paid.body?.error || paid.status}).${paid.body?.error === 'agent_bet_not_placed_funds_in_portfolio' ? ' The stake is on your ICARE Portfolio.' : ''}`)
  }
  return { placed: true, matchId, side, stakeUsdc, paidUsdc: usdc(paid.paid.amountAtomic), ...paid.body }
}

// Unités Win / Lose tenues par l'agent sur une partie.
export async function unitsHeld(matchId) {
  await ensureWallet()
  const { questionId, prediction } = await market(matchId)
  const units = await prediction.positionsOf(questionId, wallet.address.toLowerCase())
  return { win: units[0], lose: units[1] }
}

export const latestBlock = () => provider.getBlockNumber()

// Gain réel d'une partie réglée (part de la cagnotte, pas le nombre d'unités) : encore à réclamer, ou déjà versé au
// Portfolio par ICARE. Le montant versé est lu dans l'événement Claimed, en remontant depuis le dernier bloc par
// tranches de 200 jusqu'au bloc de la mise (50 tranches au plus) ; payout null = versé, montant non retrouvé.
export async function payoutOf(matchId, fromBlock) {
  await ensureWallet()
  const account = wallet.address.toLowerCase()
  const { questionId, prediction } = await market(matchId)
  const pending = await prediction.claimable(questionId, account)
  if (pending > 0n) return { payout: pending, credited: false }
  if (!(await prediction.claimed(questionId, account))) return { payout: 0n, credited: false }
  const latest = await provider.getBlockNumber()
  for (let to = latest; to >= fromBlock && latest - to < 50 * LOG_RANGE; to -= LOG_RANGE) {
    const events = await prediction.queryFilter(prediction.filters.Claimed(questionId, account), Math.max(fromBlock, to - LOG_RANGE + 1), to)
    if (events.length) return { payout: events.reduce((sum, event) => sum + event.args.payout, 0n), credited: true }
  }
  return { payout: null, credited: true }
}

export async function positions() {
  await ensureWallet()
  const cfg = await config(), account = wallet.address.toLowerCase()
  const balance = await new ethers.Contract(cfg.funds, FUNDS_ABI, provider).balanceOf(account)
  const rows = await observedRows().catch(() => [])
  const held = []
  for (const row of rows.slice(0, 15)) {
    const units = await unitsHeld(row.matchId)
    if (units.win > 0n || units.lose > 0n) held.push({ ...summary(row), winUnits: usdc(units.win), loseUnits: usdc(units.lose) })
  }
  return { wallet: account, portfolioUsdc: usdc(balance), positions: held }
}

// Prix de rachat proposé par la liquidité ICARE pour des unités tenues (null quand aucun prix n'est offert).
export async function sellQuote({ matchId, side, units }) {
  await ensureWallet()
  const outcome = side === 'win' ? 0 : 1, account = wallet.address.toLowerCase()
  const { questionId, prediction, predictionAddress } = await market(matchId)
  const held = (await prediction.positionsOf(questionId, account))[outcome]
  const amount = units ? ethers.parseUnits(units, 6) : held
  if (amount <= 0n || amount > held) throw new IcareError(`You hold ${usdc(held)} ${side} units on match ${matchId}.`)
  const quote = await json(`${API}/api/observed/maker/quote?matchId=${matchId}&outcome=${outcome}&units=${amount}`)
  if (!quote.body?.price) return null
  const price = BigInt(quote.body.price), [, , sellerProceeds] = await prediction.quoteTransferFees(questionId, price)
  return { matchId, side, outcome, amount, price, sellerProceeds, questionId, predictionAddress }
}

export async function sell({ matchId, side, units }) {
  const quote = await sellQuote({ matchId, side, units })
  if (!quote) throw new IcareError('No buyback price right now (market closed, exits locked or liquidity limit reached).')
  const cfg = await config(), account = wallet.address.toLowerCase()
  const offer = { questionId: quote.questionId, seller: account, outcome: quote.outcome, units: quote.amount.toString(), price: quote.price.toString(), minSellerProceeds: quote.sellerProceeds.toString(),
    nonce: ((BigInt(Date.now()) << 64n) | BigInt(ethers.hexlify(ethers.randomBytes(8)))).toString(), deadline: String(Math.floor(Date.now() / 1000) + 3_600) }
  const signature = await wallet.signTypedData({ name: 'CantorFi Prediction', version: '1', chainId: cfg.chainId, verifyingContract: quote.predictionAddress }, OFFER_TYPES, offer)
  const published = await json(`${API}/api/index/prediction/offers`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: cfg.chainId, contractAddress: quote.predictionAddress, kind: 'mono', offer, signature }) })
  if (![200, 201].includes(published.status)) throw new IcareError(`Offer refused (${published.body?.error || published.status}).`)
  return { offered: true, matchId, side, units: usdc(quote.amount), priceUsdc: usdc(quote.price), youReceiveUsdc: usdc(quote.sellerProceeds), note: 'ICARE liquidity fills it within seconds; check icare_positions.' }
}

export async function season() {
  const { status, body } = await json(`${SEASON}?limit=10`)
  if (status !== 200) throw new IcareError('Season 0 leaderboard unavailable.')
  return body?.data || body
}

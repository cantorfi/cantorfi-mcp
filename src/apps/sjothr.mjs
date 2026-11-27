// Sjothr (company raises in USDC, an application built on CantorFi): the agent reads the raises at the Sjothr door and
// invests from its own wallet. The door prepares the transactions from the contract's quote; the agent checks them
// before signing: an allowance in the USDC of the CantorFi manifest, to the contract registered for Sjothr in the
// CantorFi registry, within the owner's ceiling, then the purchase on that same contract.
import { ethers } from 'ethers'
import { AgentError, readState, saveState } from '../agent/state.mjs'
import { tool } from '../agent/door.mjs'
import { context, signAndSend } from '../agent/chain.mjs'

const TOKEN = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)'])
const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase()

/** Refuses anything but: allowance of USDC to `target` (at most maxAtomic), then one call to `target`, no ETH. */
export function checkInvestment(prepared, { usdc, target, maxAtomic }) {
  const steps = prepared?.transactions || []
  if (steps.length !== 2) throw new AgentError('An investment is two transactions (allowance, purchase): nothing was signed.')
  const [allowance, purchase] = steps
  if (steps.some((step) => BigInt(step.value || 0) !== 0n)) throw new AgentError('An investment is paid in USDC, never with ETH attached: nothing was signed.')
  if (!same(allowance.to, usdc)) throw new AgentError('The allowance is not on the USDC of the CantorFi manifest: nothing was signed.')
  let spender, amount
  try { [spender, amount] = TOKEN.decodeFunctionData('approve', allowance.data) } catch { throw new AgentError('The first transaction is not a token allowance: nothing was signed.') }
  if (!same(spender, target)) throw new AgentError('The allowance names a spender that is not the contract registered for this application on CantorFi: nothing was signed.')
  if (amount > maxAtomic) throw new AgentError(`The allowance (${ethers.formatUnits(amount, 6)} USDC) is above the ceiling (${ethers.formatUnits(maxAtomic, 6)} USDC): nothing was signed. Raise it with --max.`)
  if (!same(purchase.to, target)) throw new AgentError('The purchase is not sent to the contract registered for this application on CantorFi: nothing was signed.')
  return { totalAtomic: amount }
}

export const campaigns = (app) => tool(app.agentEndpoint, 'sjothr_campaigns')
export const rules = (app) => tool(app.agentEndpoint, 'sjothr_rules')

/** Invests `amount` USDC in a raise; `max` (USDC) caps what leaves the wallet, fee included (default: amount + 20%). */
export async function invest(app, campaignId, amount, max, log = () => {}) {
  const { wallet, contracts } = await context()
  if (!app.feeRecipient) throw new AgentError(`${app.name || app.appId} has no contract registered on CantorFi.`)
  const prepared = await tool(app.agentEndpoint, 'sjothr_prepare', { action: 'invest', campaignId, amount, wallet: wallet.address })
  const maxAtomic = max ? ethers.parseUnits(max, 6) : ethers.parseUnits(amount, 6) * 12n / 10n
  const { totalAtomic } = checkInvestment(prepared, { usdc: contracts.tokens.USDC, target: app.feeRecipient, maxAtomic })
  const transactions = await signAndSend(prepared, log, [app.feeRecipient])
  return { done: `invested ${prepared.amount} USDC in ${prepared.campaign?.name || campaignId}`, paid: `${ethers.formatUnits(totalAtomic, 6)} USDC from the wallet`,
    fee: prepared.fee, transactions, page: prepared.campaign?.page, condition: prepared.condition }
}

const PREPARE_TOOLS = new Set(['sjothr_risk_prepare', 'sjothr_market_prepare', 'sjothr_backer_prepare', 'sjothr_founder_prepare'])
const ROUNDS = new ethers.Interface([
  'function campaignIdByCreator(address creator) view returns (bytes32)',
  'function roundsOf(bytes32 campaignId) view returns ((address vault, uint256 saleAllocation, uint256 fundingGoal, uint256 pricePerToken, uint64 deadline, bool listing, uint8 outcome, uint256 sold)[])',
])

/** Vaults of the rounds of the raise this wallet created, read on the Sjothr contract itself (never from the door). */
export async function ownRoundVaults(provider, sjothr, wallet) {
  const contract = new ethers.Contract(sjothr, ROUNDS, provider)
  const campaignId = await contract.campaignIdByCreator(wallet)
  if (/^0x0{64}$/.test(campaignId)) return []
  return (await contract.roundsOf(campaignId)).map((round) => round.vault)
}

/** Refuses anything but transactions to the Sjothr contract registered on CantorFi, and at most one USDC allowance to it,
 *  within maxAtomic for the whole action. */
const VAULT = new ethers.Interface([
  'function requestRelease(string evidenceUri, bytes32 evidenceHash) returns (uint256)',
  'function finalizeProposal(uint256 proposalId)',
  'function withdrawCreatorFunds(address recipient, uint256 amount)',
])

/** A call to a round vault of the wallet's own raise: only the founder's request, the vote's record and a withdrawal
 *  paid to the wallet itself. */
function checkVaultCall(step, wallet) {
  let call
  try { call = VAULT.parseTransaction({ data: step.data }) } catch { call = null }
  if (!call) throw new AgentError('A round vault call that is not a release request, a vote record or a withdrawal: nothing was signed.')
  if (call.name === 'withdrawCreatorFunds' && !same(call.args.recipient, wallet)) throw new AgentError('The withdrawal pays an address that is not this wallet: nothing was signed.')
}

export function checkSjothrAction(prepared, { usdc, target, maxAtomic, vaults = [], wallet }) {
  const steps = prepared?.transactions || []
  if (!steps.length) throw new AgentError('Nothing was prepared: nothing was signed.')
  let allowances = 0, total = 0n
  for (const step of steps) {
    if (BigInt(step.value || 0) !== 0n) throw new AgentError('A Sjothr action never sends ETH: nothing was signed.')
    if (same(step.to, target)) continue
    if (vaults.some((vault) => same(step.to, vault)) && !same(step.to, usdc)) { checkVaultCall(step, wallet ?? prepared.wallet); continue }
    if (!same(step.to, usdc)) throw new AgentError(`${step.to} is neither the Sjothr contract registered on CantorFi, nor a round vault of this wallet's own raise, nor the USDC of the manifest: nothing was signed.`)
    let spender, amount
    try { [spender, amount] = TOKEN.decodeFunctionData('approve', step.data) } catch { throw new AgentError('A USDC transaction that is not an allowance: nothing was signed.') }
    if (!same(spender, target)) throw new AgentError('The allowance names a spender that is not the Sjothr contract: nothing was signed.')
    allowances += 1
    total += amount
  }
  if (allowances > 1) throw new AgentError('A Sjothr action asks for one USDC allowance at most: nothing was signed.')
  if (total > maxAtomic) throw new AgentError(`The allowance (${ethers.formatUnits(total, 6)} USDC) is above the ceiling (${ethers.formatUnits(maxAtomic, 6)} USDC): nothing was signed. Raise it with --max.`)
}

/** One prepared Sjothr action (credit risk, Market, backer, founder), checked then signed by the agent's wallet. A founder
 *  action may also go to the vaults of the rounds of the wallet's own raise, read on the Sjothr contract. */
export async function act(app, toolName, input, max, log = () => {}) {
  if (!PREPARE_TOOLS.has(toolName)) throw new AgentError(`"${toolName}" is not a Sjothr action; use one of: ${[...PREPARE_TOOLS].join(', ')}.`)
  const { wallet, contracts, provider } = await context()
  if (!app.feeRecipient) throw new AgentError(`${app.name || app.appId} has no contract registered on CantorFi.`)
  const prepared = await tool(app.agentEndpoint, toolName, { ...input, wallet: wallet.address })
  const vaults = toolName === 'sjothr_founder_prepare' ? await ownRoundVaults(provider, app.feeRecipient, wallet.address) : []
  checkSjothrAction(prepared, { usdc: contracts.tokens.USDC, target: app.feeRecipient, maxAtomic: ethers.parseUnits(max || '100', 6), vaults, wallet: wallet.address })
  const transactions = await signAndSend(prepared, log, [app.feeRecipient, ...vaults])
  return { done: `${toolName.replace('sjothr_', '').replace('_prepare', '')} ${prepared.action}`, transactions, condition: prepared.condition }
}

export const tribunal = (app) => tool(app.agentEndpoint, 'sjothr_tribunal')

/** The four findings of a juror under Sjothr's code, in the order of the code (Articles 10 to 13). */
export const FINDINGS = ['default', 'eligible', 'loss', 'goodFaith']
const CODE = new ethers.Interface(['function riskPoolCode(bytes32 poolId) view returns (uint16 number, (bytes32 hash, uint64 since, string uri) code, uint8 companyBreach)'])

/** The law of a portfolio: Sjothr's code from the door, its text checked here against the fingerprint read on the
 *  Sjothr contract itself (never trusted from the door alone). */
export async function code(app, poolId) {
  const { provider } = await context()
  const law = await tool(app.agentEndpoint, 'sjothr_code', poolId ? { poolId } : {})
  if (!poolId) return law
  const [number, onChain] = await new ethers.Contract(app.feeRecipient, CODE, provider).riskPoolCode(poolId)
  const fingerprint = ethers.keccak256(ethers.toUtf8Bytes(law.text || ''))
  if (Number(number) !== law.codeVersion || !same(onChain.hash, fingerprint)) {
    throw new AgentError(`The code given by the door is not the one fixed on chain for ${poolId} (version ${number}, ${onChain.hash}): do not judge from it.`)
  }
  return { ...law, verifiedOnChain: `The text's keccak256 equals the fingerprint of version ${number} read on the Sjothr contract.` }
}

/** Established findings from a list of names (`none` for none). */
export function findingsFrom(list) {
  const named = String(list || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (named.length === 1 && named[0] === 'none') return Object.fromEntries(FINDINGS.map((key) => [key, false]))
  const unknown = named.filter((item) => !FINDINGS.includes(item))
  if (!named.length || unknown.length) throw new AgentError(`Findings are the established ones among ${FINDINGS.join(', ')}, separated by commas, or none.`)
  return Object.fromEntries(FINDINGS.map((key) => [key, named.includes(key)]))
}

/** Juror of Sjothr's tribunal: hidden findings on a contested claim, after checking the portfolio's code on chain.
 *  The salt is drawn here; salt, findings and reasons are kept in the agent's state (nothing is sent before the reveal
 *  but the fingerprint): without the salt the findings can't be opened and the ticket is lost. */
export async function vote(app, poolId, findings, reasons, max, log = () => {}) {
  await code(app, poolId)
  const salt = ethers.hexlify(ethers.randomBytes(32))
  const result = await act(app, 'sjothr_risk_prepare', { action: 'vote', poolId, findings, reasons, salt }, max || '5', log)
  const state = await readState()
  await saveState({ ...state, sjothrVotes: { ...(state.sjothrVotes || {}), [poolId.toLowerCase()]: { findings, reasons, salt } } })
  return { ...result, findings, keep: 'Salt, findings and reasons are kept in the agent state; open them with: cantorfi-agent sjothr reveal ' + poolId }
}

/** Opens the hidden findings left by this agent on a contested claim, with its reasons. */
export async function reveal(app, poolId, log = () => {}) {
  const saved = (await readState()).sjothrVotes?.[poolId.toLowerCase()]
  if (!saved) throw new AgentError(`This agent left no hidden vote on ${poolId}.`)
  if (!saved.findings) throw new AgentError(`The hidden vote on ${poolId} was left before Sjothr's code: it has no findings to open.`)
  return act(app, 'sjothr_risk_prepare', { action: 'reveal', poolId, findings: saved.findings, reasons: saved.reasons, salt: saved.salt }, '0', log)
}

const FILE_KINDS = [[/^image\//, 'photo'], [/^video\//, 'video'], [/^application\/pdf/, 'pdf']]
const EXTENSIONS = { jpg: 'photo', jpeg: 'photo', png: 'photo', gif: 'photo', webp: 'photo', avif: 'photo', mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', pdf: 'pdf' }
const MAX_FILE_BYTES = 200 * 1024 * 1024

/** Fingerprint (keccak256 of the exact bytes) and kind of a public file, read here at publication. */
export async function fingerprintFile(file, fetcher = fetch) {
  const url = String(file?.url || '')
  if (!/^https:\/\//.test(url)) throw new AgentError(`${url || 'A file'} must be a public https address to be fingerprinted.`)
  const response = await fetcher(url, { redirect: 'follow' })
  if (!response.ok) throw new AgentError(`${url} answered ${response.status}: the file can't be fingerprinted.`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new AgentError(`${url} is empty or larger than 200 MB.`)
  const type = String(response.headers.get('content-type') || '').toLowerCase()
  const extension = url.split('?')[0].split('.').pop().toLowerCase()
  const kind = file.kind || FILE_KINDS.find(([pattern]) => pattern.test(type))?.[1] || EXTENSIONS[extension]
  if (!kind) throw new AgentError(`${url} is neither a photo, a video nor a PDF.`)
  return { name: String(file.name || decodeURIComponent(url.split('?')[0].split('/').pop())).slice(0, 120), kind, url, fingerprint: ethers.keccak256(bytes) }
}

/** Founder's update, written by the founder's wallet or by the writer it invited (its AI agent): what was really done,
 *  with public links and files, each file fingerprinted here from its bytes. A writer names the raise (campaignId). */
export async function progress(app, update, campaignId, log = () => {}, fetcher = fetch) {
  const files = []
  for (const file of update.files || []) files.push(await fingerprintFile(file, fetcher))
  const input = { action: 'publish_update', title: update.title, text: update.text, links: update.links || [], files, ...(campaignId ? { campaignId } : {}) }
  return { ...(await act(app, 'sjothr_founder_prepare', input, '0', log)), files }
}

/** The founder invites (or removes, with none) the wallet of its AI agent as the writer of its updates. */
export const setWriter = (app, writer, log = () => {}) =>
  act(app, 'sjothr_founder_prepare', { action: 'set_writer', writer: writer === 'none' ? null : writer }, '0', log)

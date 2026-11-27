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

/** Juror of Sjothr's tribunal: a hidden vote on a contested claim. The salt is drawn here and kept in the agent's state
 *  (never sent before the reveal): without it the vote can't be opened and the ticket is lost. */
export async function vote(app, poolId, uphold, max, log = () => {}) {
  const salt = ethers.hexlify(ethers.randomBytes(32))
  const result = await act(app, 'sjothr_risk_prepare', { action: 'vote', poolId, uphold, salt }, max || '5', log)
  const state = await readState()
  await saveState({ ...state, sjothrVotes: { ...(state.sjothrVotes || {}), [poolId.toLowerCase()]: { uphold, salt } } })
  return { ...result, keep: 'The salt of this vote is kept in the agent state; open it with: cantorfi-agent sjothr reveal ' + poolId }
}

/** Opens the hidden vote left by this agent on a contested claim. */
export async function reveal(app, poolId, log = () => {}) {
  const saved = (await readState()).sjothrVotes?.[poolId.toLowerCase()]
  if (!saved) throw new AgentError(`This agent left no hidden vote on ${poolId}.`)
  return act(app, 'sjothr_risk_prepare', { action: 'reveal', poolId, uphold: saved.uphold, salt: saved.salt }, '0', log)
}


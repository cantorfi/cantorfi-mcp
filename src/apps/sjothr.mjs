// Sjothr (company raises in USDC, an application built on CantorFi): the agent reads the raises at the Sjothr door and
// invests from its own wallet. The door prepares the transactions from the contract's quote; the agent checks them
// before signing: an allowance in the USDC of the CantorFi manifest, to the contract registered for Sjothr in the
// CantorFi registry, within the owner's ceiling, then the purchase on that same contract.
import { ethers } from 'ethers'
import { AgentError } from '../agent/state.mjs'
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

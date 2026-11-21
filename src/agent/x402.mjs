// Generic x402 payment of the agent: any x402 version 2 desk, scheme "exact", token with signed authorizations
// (EIP-3009, USDC). The wallet needs the token only: no gas, no approval, no account. The agent signs only when the
// price fits its ceiling, the announced resource is the one it asked for, and the signing domain is the token's own.
import { randomBytes, randomUUID } from 'node:crypto'
import { ethers } from 'ethers'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import { AgentError } from './state.mjs'

const TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

/** The offer of a 402 answer this wallet can pay: exact amount, its own chain, signed authorization. */
export function chooseTerms(required, chainId) {
  return (required?.accepts || []).find((entry) => entry.scheme === 'exact' && entry.network === `eip155:${chainId}`
    && entry.extra?.name && entry.extra?.version && entry.extra?.assetTransferMethod !== 'permit2') || null
}

/**
 * POSTs `body` to `url`; on HTTP 402 pays the announced price and repeats the request.
 * `maxAtomic` is the ceiling in token units; `expect` pins the receiver, the token and the exact amount when the
 * caller already knows them. Returns the final status and body, and `paid` when a payment was made.
 */
export async function payX402({ url, body, headers = {}, wallet, provider, maxAtomic, expect = null, timeoutMs = 150_000 }) {
  const init = { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }
  const first = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (first.status !== 402) return { status: first.status, body: await first.json().catch(() => null), paid: null }
  const header = first.headers.get('PAYMENT-REQUIRED')
  const required = header ? decodePaymentRequiredHeader(header) : await first.json().catch(() => null)
  const { chainId } = await provider.getNetwork()
  const terms = chooseTerms(required, chainId)
  if (!terms) throw new AgentError('x402: no offer this wallet can pay (exact amount, signed authorization, its own chain).')
  if (required.resource?.url && required.resource.url !== url) throw new AgentError(`x402: the desk announces another resource (${required.resource.url}), nothing was signed.`)
  const amount = BigInt(terms.amount)
  if (expect && (!same(terms.payTo, expect.payTo) || !same(terms.asset, expect.asset) || amount !== BigInt(expect.amount))) {
    throw new AgentError('x402: unexpected payment request, nothing was signed.')
  }
  if (amount > BigInt(maxAtomic)) throw new AgentError(`x402: the price (${amount}) is above the ceiling (${maxAtomic}), nothing was signed.`)
  const domain = { name: terms.extra.name, version: terms.extra.version, chainId: Number(chainId), verifyingContract: terms.asset }
  const token = new ethers.Contract(terms.asset, ['function DOMAIN_SEPARATOR() view returns (bytes32)', 'function balanceOf(address) view returns (uint256)'], provider)
  if (await token.DOMAIN_SEPARATOR() !== ethers.TypedDataEncoder.hashDomain(domain)) throw new AgentError('x402: the announced signing domain is not the token\'s, nothing was signed.')
  if (await token.balanceOf(wallet.address) < amount) throw new AgentError('x402: the wallet does not hold enough of the payment token.')
  const now = Math.floor(Date.now() / 1000)
  const authorization = { from: wallet.address, to: terms.payTo, value: terms.amount, validAfter: '0',
    validBefore: String(now + Math.min(Number(terms.maxTimeoutSeconds) || 240, 600)), nonce: ethers.hexlify(randomBytes(32)) }
  const signature = await wallet.signTypedData(domain, TYPES, authorization)
  // Payment identifier: when the desk offers it, repeating the same request returns the same paid answer.
  const extensions = structuredClone(required.extensions || {})
  if (extensions['payment-identifier']?.info) extensions['payment-identifier'].info.id = `pay_${randomUUID().replace(/-/g, '')}`
  const payment = { x402Version: required.x402Version ?? 2, ...(required.resource ? { resource: required.resource } : {}), accepted: terms,
    payload: { authorization, signature }, ...(Object.keys(extensions).length ? { extensions } : {}) }
  const second = await fetch(url, { ...init, headers: { ...init.headers, 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payment) }, signal: AbortSignal.timeout(timeoutMs) })
  const receiptHeader = second.headers.get('PAYMENT-RESPONSE')
  let receipt = null
  try { receipt = receiptHeader ? decodePaymentResponseHeader(receiptHeader) : null } catch { receipt = null }
  return { status: second.status, body: await second.json().catch(() => null), terms,
    paid: second.status >= 200 && second.status < 300 ? { amountAtomic: terms.amount, asset: terms.asset, payTo: terms.payTo, transaction: receipt?.transaction ?? null } : null }
}

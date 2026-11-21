import { ethers } from 'ethers'
import { x402Client } from '@x402/core/client'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, decodePaymentResponseHeader } from '@x402/core/http'

export const TICKET_ABI = [
  'function tickets(bytes32,address) view returns(address beneficiary,bool claimed)',
  'function ticketNonce(bytes32,address) pure returns(bytes32)',
  'function token() view returns(address)',
  'function TICKET_PRICE() view returns(uint256)',
  'function buyTicket(bytes32,address)',
  'function cases(bytes32) view returns(uint256 matchId,bytes32 dossierHash,uint64 closesAt,uint32 ticketCount,uint8 outcome,address winner,bytes32 answersDigest,bool feeWithdrawn)',
  'event TicketPurchased(bytes32 indexed caseKey,address indexed agent,address beneficiary)',
]
const TYPES = { ReceiveWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

export async function buyTicketDirect({ required, dossier, wallet, provider, escrow, token, chainId }) {
  const payment = required?.payment
  if (required?.error !== 'tribunal_payment_required' || payment?.method !== 'buyTicket' ||
      payment.amount !== '1000000' || payment.chainId !== chainId || !same(payment.contract, escrow) ||
      !same(payment.token, token) || payment.caseKey !== dossier.payment.caseKey) throw Error('agent_payment_mismatch')
  const onchain = new ethers.Contract(escrow, TICKET_ABI, provider)
  const [network, asset, price, affair, ticket, block] = await Promise.all([
    provider.getNetwork(), onchain.token(), onchain.TICKET_PRICE(), onchain.cases(payment.caseKey),
    onchain.tickets(payment.caseKey, wallet.address), provider.getBlock('latest'),
  ])
  if (Number(network.chainId) !== chainId || !same(asset, token) || price !== 1_000_000n ||
      String(affair.matchId) !== dossier.matchId || affair.dossierHash !== dossier.payment.dossierHash ||
      Number(affair.closesAt) !== Math.floor(dossier.closesAt / 1000)) throw Error('agent_payment_case_mismatch')
  if (same(ticket.beneficiary, wallet.address)) return null
  if (ticket.beneficiary !== ethers.ZeroAddress) throw Error('agent_payment_beneficiary_mismatch')
  if (affair.outcome !== 0n || Number(affair.closesAt) <= block.timestamp + 5) throw Error('agent_payment_window_closed')
  const signer = wallet.connect(provider)
  const assetContract = new ethers.Contract(token, [
    'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)',
  ], signer)
  const confirmed = async tx => {
    const receipt = await (await tx).wait()
    if (receipt?.status !== 1) throw Error('agent_payment_unconfirmed')
    return receipt
  }
  const allowance = await assetContract.allowance(wallet.address, escrow)
  if (allowance < price) {
    if (allowance !== 0n) await confirmed(assetContract.approve(escrow, 0n))
    await confirmed(assetContract.approve(escrow, price))
  }
  const receipt = await confirmed(onchain.connect(signer).buyTicket(payment.caseKey, wallet.address))
  if (!same((await onchain.tickets(payment.caseKey, wallet.address)).beneficiary, wallet.address)) throw Error('agent_payment_unconfirmed')
  return receipt.hash
}

export async function signTicket({ response, dossier, wallet, provider, escrow, token, chainId, apiUrl }) {
  const header = response.headers.get('PAYMENT-REQUIRED')
  if (!header || header.length > 16_384) throw Error('x402_payment_required_missing')
  const required = decodePaymentRequiredHeader(header)
  if (required.x402Version !== 2 || required.resource?.url !== `${new URL(apiUrl).origin}/api/tribunal/cases/${dossier.caseId}/ticket`) throw Error('x402_resource_mismatch')
  const onchain = new ethers.Contract(escrow, TICKET_ABI, provider)
  const [network, asset, nonce, affair] = await Promise.all([
    provider.getNetwork(), onchain.token(), onchain.ticketNonce(dossier.payment.caseKey, wallet.address), onchain.cases(dossier.payment.caseKey),
  ])
  if (Number(network.chainId) !== chainId || !same(asset, token) || String(affair.matchId) !== dossier.matchId ||
      affair.dossierHash !== dossier.payment.dossierHash || Number(affair.closesAt) !== Math.floor(dossier.closesAt / 1000)) throw Error('x402_case_mismatch')
  const scheme = { scheme: 'icare-tribunal', createPaymentPayload: async (x402Version, r) => {
    if (x402Version !== 2 || r.network !== `eip155:${chainId}` || r.amount !== '1000000' ||
        !same(r.asset, token) || !same(r.payTo, escrow) || r.maxTimeoutSeconds !== 60 ||
        r.extra?.caseKey !== dossier.payment.caseKey || r.extra.nonce !== nonce ||
        r.extra.closesAt !== Number(affair.closesAt)) throw Error('x402_payment_mismatch')
    const domain = { name: r.extra.name, version: r.extra.version, chainId, verifyingContract: token }
    const assetContract = new ethers.Contract(token, ['function DOMAIN_SEPARATOR() view returns(bytes32)'], provider)
    if (await assetContract.DOMAIN_SEPARATOR() !== ethers.TypedDataEncoder.hashDomain(domain)) throw Error('x402_domain_mismatch')
    const now = Math.floor(Date.now() / 1000), validBefore = Math.min(now + 55, Number(affair.closesAt) - 2)
    if (validBefore <= now + 5) throw Error('x402_window_too_short')
    const authorization = { from: wallet.address, to: escrow, value: '1000000', validAfter: '0', validBefore: String(validBefore), nonce }
    return { x402Version, payload: { authorization, signature: await wallet.signTypedData(domain, TYPES, authorization) } }
  } }
  const client = new x402Client().register(`eip155:${chainId}`, scheme)
  return encodePaymentSignatureHeader(await client.createPaymentPayload(required))
}

export async function confirmTicket({ response, dossier, wallet, provider, escrow, chainId }) {
  const header = response.headers.get('PAYMENT-RESPONSE')
  const onchain = new ethers.Contract(escrow, TICKET_ABI, provider)
  const ticket = await onchain.tickets(dossier.payment.caseKey, wallet.address)
  if (!same(ticket.beneficiary, wallet.address)) throw Error('x402_ticket_unconfirmed')
  if (!header) return null // A retried, already admitted ticket has no second payment.
  if (header.length > 16_384) throw Error('x402_receipt_invalid')
  const result = decodePaymentResponseHeader(header)
  if (!result.success || result.network !== `eip155:${chainId}` || !same(result.payer, wallet.address) || !/^0x[\da-fA-F]{64}$/.test(result.transaction || '')) throw Error('x402_receipt_invalid')
  const receipt = await provider.getTransactionReceipt(result.transaction)
  const event = receipt?.logs.filter(log => same(log.address, escrow)).map(log => {
    try { return onchain.interface.parseLog(log) } catch { return null }
  }).find(log => log?.name === 'TicketPurchased' && log.args.caseKey === dossier.payment.caseKey && same(log.args.agent, wallet.address) && same(log.args.beneficiary, wallet.address))
  if (receipt?.status !== 1 || !event) throw Error('x402_receipt_unconfirmed')
  return result.transaction
}

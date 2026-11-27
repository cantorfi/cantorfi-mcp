// Sjothr through the single agent: what the agent accepts to sign for an investment prepared by the Sjothr door.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ethers } from 'ethers'
import { checkInvestment, checkSjothrAction } from '../src/apps/sjothr.mjs'
import { AgentError } from '../src/agent/state.mjs'

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const SJOTHR = '0xF6D4eEC8243ee42f5Ba3a3caf4d74A7793285c81'
const WALLET = '0xb1567002FbCBE3584b9634De6Af3b23dD8a36F2E'
const OTHER = '0x000000000000000000000000000000000000dEaD'
const token = new ethers.Interface(['function approve(address spender, uint256 amount) returns (bool)'])
const prepared = (overrides = {}) => ({
  chainId: 84532, action: 'invest', wallet: WALLET, amount: '5', amountAtomic: '5000000', totalFromWalletUsdc: '5.5',
  transactions: [
    { step: 1, description: 'Allow', from: WALLET, to: USDC, data: token.encodeFunctionData('approve', [SJOTHR, 5_500_000n]), value: '0x0' },
    { step: 2, description: 'Invest', from: WALLET, to: SJOTHR, data: '0x26b136e6' + '00'.repeat(96), value: '0x0' },
  ],
  ...overrides,
})
const rules = { usdc: USDC, target: SJOTHR.toLowerCase(), maxAtomic: 6_000_000n }

test('the agent signs an investment only toward USDC and the contract registered for Sjothr on CantorFi, within its ceiling', () => {
  assert.deepEqual(checkInvestment(prepared(), rules), { totalAtomic: 5_500_000n })
  const refused = (value, pattern) => assert.throws(() => checkInvestment(value, rules), (error) => error instanceof AgentError && pattern.test(error.message))
  // An allowance to another spender, a purchase sent elsewhere, an allowance above the ceiling, ETH attached, extra steps.
  refused(prepared({ transactions: [{ ...prepared().transactions[0], data: token.encodeFunctionData('approve', [OTHER, 5_500_000n]) }, prepared().transactions[1]] }), /spender/i)
  refused(prepared({ transactions: [prepared().transactions[0], { ...prepared().transactions[1], to: OTHER }] }), /registered/i)
  refused(prepared({ transactions: [{ ...prepared().transactions[0], to: OTHER }, prepared().transactions[1]] }), /USDC/)
  refused(prepared({ transactions: [{ ...prepared().transactions[0], data: token.encodeFunctionData('approve', [SJOTHR, 6_000_001n]) }, prepared().transactions[1]] }), /ceiling/i)
  refused(prepared({ transactions: [prepared().transactions[0], { ...prepared().transactions[1], value: '0x1' }] }), /ETH/)
  refused(prepared({ transactions: [...prepared().transactions, prepared().transactions[1]] }), /two transactions/i)
  refused(prepared({ transactions: [{ ...prepared().transactions[0], data: '0xa9059cbb' + '00'.repeat(64) }, prepared().transactions[1]] }), /allowance/i)
})

test('a credit risk, Market or backer action is signed only towards the Sjothr contract, USDC allowances within the ceiling', () => {
  assert.doesNotThrow(() => checkSjothrAction(prepared(), rules))
  assert.doesNotThrow(() => checkSjothrAction({ transactions: [{ to: SJOTHR, data: '0x12345678', value: '0x0' }] }, rules))
  const refused = (value, pattern) => assert.throws(() => checkSjothrAction(value, rules), (error) => error instanceof AgentError && pattern.test(error.message))
  refused({ transactions: [] }, /Nothing was prepared/)
  refused({ transactions: [{ to: OTHER, data: '0x12345678', value: '0x0' }] }, /neither the Sjothr contract/)
  refused({ transactions: [{ to: SJOTHR, data: '0x12345678', value: '0x1' }] }, /never sends ETH/)
  refused({ transactions: [{ to: USDC, data: token.encodeFunctionData('approve', [OTHER, 1n]), value: '0x0' }] }, /spender that is not/)
  refused({ transactions: [{ to: USDC, data: token.encodeFunctionData('approve', [SJOTHR, 7_000_000n]), value: '0x0' }] }, /above the ceiling/)
})

test('the ceiling covers the whole Sjothr action: one allowance at most', () => {
  const allow = (amount) => ({ to: USDC, data: token.encodeFunctionData('approve', [SJOTHR, amount]), value: '0x0' })
  assert.throws(() => checkSjothrAction({ transactions: [allow(4_000_000n), allow(4_000_000n)] }, rules), (error) => error instanceof AgentError && /one USDC allowance at most/.test(error.message))
})

test('a founder action may go to a vault of its own raise (read on the Sjothr contract), never to another address', () => {
  const VAULT = '0x4444444444444444444444444444444444444444'
  const vault = new ethers.Interface(['function withdrawCreatorFunds(address recipient, uint256 amount)', 'function finalizeProposal(uint256)'])
  const own = { ...rules, vaults: [VAULT], wallet: WALLET }
  const toVault = (data, value = '0x0') => ({ transactions: [{ to: VAULT, data, value }] })
  assert.doesNotThrow(() => checkSjothrAction(toVault(vault.encodeFunctionData('withdrawCreatorFunds', [WALLET, 5_000_000n])), own))
  assert.doesNotThrow(() => checkSjothrAction(toVault(vault.encodeFunctionData('finalizeProposal', [3n])), own))
  assert.throws(() => checkSjothrAction(toVault(vault.encodeFunctionData('finalizeProposal', [3n])), rules), (error) => error instanceof AgentError && /round vault of this wallet's own raise/.test(error.message))
  // A withdrawal to another address, an unknown vault call, ETH attached.
  assert.throws(() => checkSjothrAction(toVault(vault.encodeFunctionData('withdrawCreatorFunds', [OTHER, 5_000_000n])), own), /not this wallet/)
  assert.throws(() => checkSjothrAction(toVault('0x12345678'), own), /nothing was signed/)
  assert.throws(() => checkSjothrAction(toVault(vault.encodeFunctionData('finalizeProposal', [3n]), '0x1'), own), /ETH/)
})

test("a juror's findings are named from Sjothr's code; nothing else is accepted", async () => {
  const { findingsFrom } = await import('../src/apps/sjothr.mjs')
  assert.deepEqual(findingsFrom('default,eligible,loss'), { default: true, eligible: true, loss: true, goodFaith: false })
  assert.deepEqual(findingsFrom('none'), { default: false, eligible: false, loss: false, goodFaith: false })
  for (const wrong of ['', 'confirm', 'default,guilty']) assert.throws(() => findingsFrom(wrong), (error) => error instanceof AgentError && /established ones/.test(error.message))
})

test("the founder's agent fingerprints each proof file from its exact bytes before publishing it", async () => {
  const { fingerprintFile } = await import('../src/apps/sjothr.mjs')
  const bytes = new TextEncoder().encode('pilot video bytes')
  const fetcher = async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } })
  const file = await fingerprintFile({ url: 'https://startup.example/week-48/pilot.mp4' }, fetcher)
  assert.deepEqual(file, { name: 'pilot.mp4', kind: 'video', url: 'https://startup.example/week-48/pilot.mp4', fingerprint: ethers.keccak256(bytes) })
  await assert.rejects(fingerprintFile({ url: 'http://startup.example/a.pdf' }, fetcher), /public https/)
  await assert.rejects(fingerprintFile({ url: 'https://startup.example/a.pdf' }, async () => new Response('', { status: 404 })), /answered 404/)
  await assert.rejects(fingerprintFile({ url: 'https://startup.example/notes.txt' }, async () => new Response('x', { headers: { 'content-type': 'text/plain' } })), /neither a photo/)
})

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

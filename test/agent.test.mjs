// The single agent: choice of the x402 offer it can pay, and the door client against a local door.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { hello, tool, tools } from '../src/agent/door.mjs'
import { AgentError } from '../src/agent/state.mjs'
import { chooseTerms } from '../src/agent/x402.mjs'

const usdc = { scheme: 'exact', network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '1000',
  payTo: '0xCe0C8321494C3BA7630f390305b40813Ff27F123', maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' } }

test('the agent pays only an exact offer, on its own chain, with a signed authorization', () => {
  assert.equal(chooseTerms({ accepts: [usdc] }, 84532n), usdc)
  // Another chain, another scheme, or a transfer that needs an approval first: nothing to sign.
  assert.equal(chooseTerms({ accepts: [usdc] }, 8453n), null)
  assert.equal(chooseTerms({ accepts: [{ ...usdc, scheme: 'upto' }] }, 84532n), null)
  assert.equal(chooseTerms({ accepts: [{ ...usdc, extra: { assetTransferMethod: 'permit2' } }] }, 84532n), null)
  assert.equal(chooseTerms({ accepts: [{ ...usdc, extra: {} }] }, 84532n), null)
  assert.equal(chooseTerms(null, 84532n), null)
  // The first payable offer wins when several are announced.
  assert.equal(chooseTerms({ accepts: [{ ...usdc, network: 'eip155:1' }, usdc] }, 84532n), usdc)
})

test('the door client lists and calls the tools of a door, and reports its refusals', async () => {
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const message = JSON.parse(raw)
      const reply = (result) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      if (message.method === 'initialize') return reply({ serverInfo: { name: 'cantorfi', version: '0.3.0' } })
      if (message.method === 'tools/list') return reply({ tools: [{ name: 'cantorfi_apps' }] })
      if (message.params.name === 'cantorfi_apps') return reply({ content: [{ type: 'text', text: '{}' }], structuredContent: { applications: [{ name: 'ICARE Arena' }] } })
      return reply({ isError: true, content: [{ type: 'text', text: 'No CantorFi vault matches "DOGE"' }] })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await hello(url)).serverInfo.name, 'cantorfi')
    assert.deepEqual((await tools(url)).map((entry) => entry.name), ['cantorfi_apps'])
    assert.deepEqual(await tool(url, 'cantorfi_apps'), { applications: [{ name: 'ICARE Arena' }] })
    await assert.rejects(tool(url, 'cantorfi_vault', { vault: 'DOGE' }), (error) => error instanceof AgentError && /No CantorFi vault/.test(error.message))
  } finally { server.close() }
})

test('an ICARE player token trade is signed only when the action is exactly the trade asked', async () => {
  const { checkTokenAction } = await import('../src/apps/icare.mjs')
  const { ethers } = await import('ethers')
  const trade = new ethers.Interface(['function tradePlayerToken(address token,bool selling,uint256 amount,uint256 minOut,uint256 deadline)'])
  const ACCOUNT = '0xb1567002FbCBE3584b9634De6Af3b23dD8a36F2E', FUNDS = '0x4adf4a76e8971659e67ffcb47e9cb62356a9ebff', TOKEN = '0xf58183464070a466728391cec343fc33e19eb896'
  const action = (overrides = {}, call = [TOKEN, false, 200_000n, 1n, 1900000000n]) => ({ account: ACCOUNT, target: FUNDS, value: '200000', relayFee: '0', nonce: '3', deadline: '1900000000', data: trade.encodeFunctionData('tradePlayerToken', call), ...overrides })
  const rules = { account: ACCOUNT, funds: FUNDS, token: TOKEN, side: 'buy', amount: '0.2' }
  assert.doesNotThrow(() => checkTokenAction(action(), rules))
  const refused = (value, pattern, overrides = {}) => assert.throws(() => checkTokenAction(value, { ...rules, ...overrides }), (error) => pattern.test(error.message))
  refused(action({ relayFee: '1' }), /relay fee/)
  refused(action({ value: '900000' }), /another USDC amount/)
  refused(action({ target: '0x000000000000000000000000000000000000dEaD' }), /not for this wallet/)
  refused(action({}, ['0x000000000000000000000000000000000000dEaD', false, 200_000n, 1n, 1900000000n]), /differs from the one asked/)
  refused(action({}, [TOKEN, true, 200_000n, 1n, 1900000000n]), /differs from the one asked/)
  refused(action({}, [TOKEN, false, 200_000n, 0n, 1900000000n]), /differs from the one asked/)
  refused(action({ data: '0x12345678' }), /not a player token trade/)
})

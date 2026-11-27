#!/usr/bin/env node
// cantorfi-agent: one agent, one wallet, one door. It connects to CantorFi only, finds there the applications built on
// CantorFi, reads vaults and its own position, signs the transactions CantorFi prepares, and pays x402 desks in USDC.
// What is specific to an application lives in one module of this repository (src/apps), never in a second agent.
import { readFile } from 'node:fs/promises'
import { ethers } from 'ethers'
import { AgentError, DIR, DOOR, KEY_KEPT_IN } from './state.mjs'
import { hello, tool, tools } from './door.mjs'
import { context, signAndSend } from './chain.mjs'
import { payX402 } from './x402.mjs'

const ICARE_APP_ID = '0x64922ce197933750158ee760f54f9f944eed9e7927caa517b93a394061a602ba'
const HELP = `cantorfi-agent: one agent with its own wallet for CantorFi and every application built on it.

  cantorfi-agent wallet                              address and balances (the wallet is created at first use)
  cantorfi-agent discover                            what the CantorFi door offers: applications, vaults, paid services
  cantorfi-agent position                            what the wallet has supplied and owes in each vault
  cantorfi-agent supply|borrow|repay|withdraw <vault> <amount>
                                                     CantorFi prepares the transactions, the wallet signs and sends them
  cantorfi-agent stake <vault> <cvt> [--days <1-365>] | unstake <vault> | claim-rewards <vault>
                                                     staking of the vault receipt token (CVT)
  cantorfi-agent swap <USDC|WETH|ETH> <USDC|WETH|ETH> <amount> [--slippage <percent>]
                                                     swap through the CantorFi router, with a minimum received
  cantorfi-agent services                            paid services (x402) and their prices
  cantorfi-agent pay <service id> '<json input>' [--max <usdc>]
                                                     pays a CantorFi service in USDC with x402: no gas, no account
  cantorfi-agent app <name> tools                    tools of an application's own door
  cantorfi-agent app <name> call <tool> ['<json>']   calls one of them

ICARE (live match predictions, an application built on CantorFi):
  cantorfi-agent icare matches                       open matches
  cantorfi-agent icare bet <matchId> <win|lose> <stake>   stake paid from the ICARE Portfolio or with x402
  cantorfi-agent icare positions | sell <matchId> <win|lose> [units] | season | activate <code>
  cantorfi-agent icare auto run|once|status|help     autonomous loop within the owner's limits
  cantorfi-agent icare tokens                        player tokens and their price
  cantorfi-agent icare token buy <symbol> <usdc> | sell <symbol> <tokens> [--slippage <percent>]
                                                     from the ICARE Portfolio, signed by the wallet, relayed by ICARE
  cantorfi-agent icare tribunal list                 open tribunal cases
  cantorfi-agent icare tribunal once|run --games <id,id> --budget <usdc>   judge cases (1 USDC ticket per case, x402)

Sjothr (company raises in USDC, an application built on CantorFi):
  cantorfi-agent sjothr campaigns | rules            public raises, and who pays which fee
  cantorfi-agent sjothr invest <campaignId> <usdc> [--max <usdc>]
                                                     Sjothr prepares the transactions from the contract quote, the wallet signs them
  cantorfi-agent sjothr portfolios | portfolio <poolId> | positions      credit risk: verified portfolios, a wallet's positions
  cantorfi-agent sjothr market [campaignId] | backer <campaignId>        startup token resale, a raise seen by the wallet
  cantorfi-agent sjothr tribunal                     claims open to contest, disputes open to jurors, verified firms
  cantorfi-agent sjothr code [poolId]                Sjothr's code, the law of the tribunal (checked on chain for a portfolio)
  cantorfi-agent sjothr vote <poolId> <established findings|none> --reasons <text|@file> [--max <usdc>]
                                                     hidden findings as a juror: default,eligible,loss,goodFaith (ticket in USDC)
  cantorfi-agent sjothr reveal <poolId>              open the findings and reasons once hidden votes are closed
  cantorfi-agent sjothr founder                      the raise this wallet created: rounds, vaults, votes, updates, writer
  cantorfi-agent sjothr writer <wallet|none>         the founder invites its AI agent's wallet to publish its updates
  cantorfi-agent sjothr progress <update.json> [campaignId]
                                                     publish an update {title,text,links,files:[{name,url}]}, files fingerprinted;
                                                     campaignId when this wallet is the invited writer
  cantorfi-agent sjothr do <sjothr_risk_prepare|sjothr_market_prepare|sjothr_backer_prepare|sjothr_founder_prepare> '<json>' [--max <usdc>]
                                                     one action of any role, checked then signed: guarantor (cover, contest…),
                                                     credit company (publish, pay_premium, file_claim, file_report…), firm
                                                     (sign_engagement, attest, sign_claim, sign_report…), anyone (pay_claim, resolve)
                                                     (example: do sjothr_risk_prepare '{"action":"cover","poolId":"0x…","tranche":0,"premium":"11.5","amount":"100"}')

Wallet key: ${KEY_KEPT_IN} (never sent). Door: ${DOOR}. State: ${DIR}`

const out = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2))
const json = (text, label) => { try { return JSON.parse(text ?? '{}') } catch { throw new AgentError(`${label} must be JSON, for example '{"token":"0x…"}'.`) } }
function flag(args, name) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
async function applications() { return (await tool(DOOR, 'cantorfi_apps')).applications }
async function application(name) {
  const wanted = String(name || '').toLowerCase()
  const found = (await applications()).find((app) => app.appId === wanted || (app.name || '').toLowerCase().split(' ')[0] === wanted || (app.name || '').toLowerCase() === wanted)
  if (!found) throw new AgentError(`No application "${name}" is registered on CantorFi; see: cantorfi-agent discover`)
  if (!found.agentEndpoint) throw new AgentError(`${found.name || found.appId} is registered on CantorFi but has not published a door for agents.`)
  return found
}

async function lend(action, vault, amount) {
  if (!vault || !amount) throw new AgentError(`Usage: cantorfi-agent ${action} <vault> <amount>, for example: cantorfi-agent ${action} USDC 25.5`)
  const { wallet } = await context()
  const prepared = await tool(DOOR, 'cantorfi_prepare', { action, vault, amount, wallet: wallet.address })
  const transactions = await signAndSend(prepared, (event) => console.error(`  ${event.step} → ${event.transaction}`))
  return { done: `${action} ${amount} ${prepared.vault.token}`, transactions, condition: prepared.condition }
}

async function staking(action, vault, args) {
  if (!vault || (action === 'stake' && !args[0])) throw new AgentError(`Usage: cantorfi-agent ${action === 'claim_rewards' ? 'claim-rewards' : action} <vault>${action === 'stake' ? ' <cvt> [--days <1-365>]' : ''}`)
  const { wallet } = await context()
  const days = flag(args, 'days')
  const prepared = await tool(DOOR, 'cantorfi_prepare', { action, vault, wallet: wallet.address, ...(action === 'stake' ? { amount: args[0], ...(days ? { lockDays: Number(days) } : {}) } : {}) })
  const transactions = await signAndSend(prepared, (event) => console.error(`  ${event.step} → ${event.transaction}`))
  return { done: `${action} on the ${prepared.vault.token} vault`, transactions, condition: prepared.condition }
}

async function swap(from, to, amount, args) {
  if (!from || !to || !amount) throw new AgentError('Usage: cantorfi-agent swap <USDC|WETH|ETH> <USDC|WETH|ETH> <amount> [--slippage <percent>]')
  const { wallet } = await context()
  const slippage = flag(args, 'slippage')
  const prepared = await tool(DOOR, 'cantorfi_prepare', { action: 'swap', from: from.toUpperCase(), to: to.toUpperCase(), amount, wallet: wallet.address, ...(slippage ? { slippage: Number(slippage) } : {}) })
  const transactions = await signAndSend(prepared, (event) => console.error(`  ${event.step} → ${event.transaction}`))
  return { done: `swapped ${amount} ${from.toUpperCase()}`, quote: prepared.quote, minimum: prepared.minimum, transactions }
}

async function icare(sub, args) {
  const app = (await applications()).find((entry) => entry.appId === ICARE_APP_ID)
  if (!app) throw new AgentError('ICARE is not registered on this CantorFi deployment.')
  const module = await import('../apps/icare.mjs')
  switch (sub) {
    case 'matches': return module.openMatches()
    case 'bet': {
      const [matchId, side, stakeUsdc] = args
      if (!/^\d+$/.test(matchId || '') || !['win', 'lose'].includes(side) || !/^\d+(\.\d+)?$/.test(stakeUsdc || '')) throw new AgentError('Usage: cantorfi-agent icare bet <matchId> <win|lose> <stake in USDC>')
      return module.placeBet({ matchId, side, stakeUsdc })
    }
    case 'positions': return module.positions()
    case 'sell': {
      const [matchId, side, units] = args
      if (!/^\d+$/.test(matchId || '') || !['win', 'lose'].includes(side)) throw new AgentError('Usage: cantorfi-agent icare sell <matchId> <win|lose> [units]')
      return module.sell({ matchId, side, units })
    }
    case 'season': return module.season()
    case 'activate': return module.activate(args[0])
    case 'auto': return (await import('../apps/icare-auto.mjs')).main(args.length ? args : ['help'])
    case 'tribunal': return tribunal(module, args)
    case 'tokens': return tool(app.agentEndpoint, 'icare_player_tokens')
    case 'token': {
      const [side, token, amount] = args
      if (!['buy', 'sell'].includes(side) || !token || !/^\d+(\.\d+)?$/.test(amount || '')) throw new AgentError('Usage: cantorfi-agent icare token buy <symbol> <usdc> | sell <symbol> <tokens> [--slippage <percent>]')
      return module.tradeToken(app.agentEndpoint, side, token, amount, flag(args, 'slippage'))
    }
    default: throw new AgentError('ICARE commands: matches, bet, positions, sell, season, activate, auto, tribunal, tokens, token. See: cantorfi-agent help')
  }
}

// ICARE tribunal: the agent buys a 1 USDC ticket per case with x402, reads the sealed proofs and answers.
async function tribunal(module, args) {
  const [mode] = args
  const config = await (await fetch(`${module.API}/api/tribunal/config`, { signal: AbortSignal.timeout(30_000) })).json()
  if (mode === 'list' || !mode) {
    const { now, cases } = await (await fetch(`${module.API}/api/tribunal/public`, { signal: AbortSignal.timeout(30_000) })).json()
    return { tribunal: config.contract, ticketUsdc: Number(config.priceAtomic) / 1e6, cases: cases.map((item) => ({ caseId: item.caseId, matchId: item.matchId,
      game: item.question?.gameAppId, phase: item.phase, closesInSeconds: Math.max(0, Math.round((item.closesAt - now) / 1000)), tickets: item.ticketCount, responses: item.responseCount })) }
  }
  if (!['once', 'run'].includes(mode)) throw new AgentError('Usage: cantorfi-agent icare tribunal list | once|run --games <id,id> --budget <usdc>')
  const budget = flag(args, 'budget'), games = String(flag(args, 'games') || '').split(',').map((game) => game.trim()).filter(Boolean)
  if (!/^\d{1,8}(\.\d{1,6})?$/.test(budget || '') || !games.length) throw new AgentError('The tribunal needs --games <gameAppId,…> and --budget <usdc> (each ticket costs 1 USDC).')
  const { contracts, wallet } = await context()
  // The payment token must be the USDC of the CantorFi manifest: the agent never trusts a token announced by an API alone.
  if (String(config.token).toLowerCase() !== String(contracts.tokens.USDC).toLowerCase()) throw new AgentError('The tribunal asks for a token that is not the USDC of the CantorFi manifest: nothing was signed.')
  const { TribunalAgent } = await import('../apps/icare-tribunal/agent.mjs')
  const { scoreImageAnalyzer, endpointAnalyzer } = await import('../apps/icare-tribunal/analyzer.mjs')
  const analyzer = flag(args, 'analyzer')
  const agent = new TribunalAgent({ apiUrl: module.API, rpcUrl: process.env.CANTORFI_RPC_URL || contracts.publicRpc, chainId: Number(config.chainId), token: config.token,
    escrow: flag(args, 'tribunal') || config.contract, wallet: new ethers.Wallet(wallet.privateKey), maxBudgetAtomic: ethers.parseUnits(budget, 6), games,
    stateFile: `${DIR}/icare/tribunal-state.json`, log: (event) => console.error(JSON.stringify(event)),
    analyze: analyzer ? endpointAnalyzer({ url: analyzer, token: process.env.CANTORFI_ANALYZER_TOKEN }) : scoreImageAnalyzer({ executable: process.env.CANTORFI_TESSERACT || 'tesseract' }) })
  let stopping = false
  process.on('SIGINT', () => { stopping = true }); process.on('SIGTERM', () => { stopping = true })
  const receipts = []
  try {
    do {
      receipts.push(...await agent.runOnce())
      if (mode === 'once') break
      for (let second = 0; second < 10 && !stopping; second += 1) await new Promise((resolve) => setTimeout(resolve, 1000))
    } while (!stopping)
  } finally { await agent.close() }
  return { processed: receipts }
}

async function sjothr(sub, args) {
  const app = await application('sjothr')
  const module = await import('../apps/sjothr.mjs')
  switch (sub) {
    case 'campaigns': return module.campaigns(app)
    case 'rules': return module.rules(app)
    case 'invest': {
      const [campaignId, amount] = args
      if (!/^0x[0-9a-fA-F]{64}$/.test(campaignId || '') || !/^\d+(\.\d+)?$/.test(amount || '')) throw new AgentError('Usage: cantorfi-agent sjothr invest <campaignId> <usdc> [--max <usdc>]')
      return module.invest(app, campaignId, amount, flag(args, 'max'), (event) => console.error(`  ${event.step} → ${event.transaction}`))
    }
    case 'portfolios': return tool(app.agentEndpoint, 'sjothr_risk_portfolios')
    case 'portfolio': return tool(app.agentEndpoint, 'sjothr_risk_portfolio', { poolId: args[0] })
    case 'positions': return tool(app.agentEndpoint, 'sjothr_risk_positions', { wallet: (await context()).wallet.address })
    case 'market': return tool(app.agentEndpoint, 'sjothr_market', args[0] ? { campaignId: args[0] } : {})
    case 'backer': return tool(app.agentEndpoint, 'sjothr_backer', { campaignId: args[0], wallet: (await context()).wallet.address })
    case 'founder': return tool(app.agentEndpoint, 'sjothr_founder', { wallet: (await context()).wallet.address })
    case 'do': return module.act(app, args[0], json(args[1], 'The action'), flag(args, 'max'), (event) => console.error(`  ${event.step} → ${event.transaction}`))
    case 'tribunal': return module.tribunal(app)
    case 'code': return module.code(app, args[0])
    case 'vote': {
      const [poolId, established] = args
      const reasonsArg = flag(args, 'reasons')
      if (!/^0x[0-9a-fA-F]{64}$/.test(poolId || '') || !established || !reasonsArg) throw new AgentError('Usage: cantorfi-agent sjothr vote <poolId> <established findings|none> --reasons <text|@file> [--max <usdc>]. Read: cantorfi-agent sjothr code <poolId>')
      const reasons = reasonsArg.startsWith('@') ? await readFile(reasonsArg.slice(1), 'utf8') : reasonsArg
      return module.vote(app, poolId, module.findingsFrom(established), reasons.trim(), flag(args, 'max'), (event) => console.error(`  ${event.step} → ${event.transaction}`))
    }
    case 'reveal': {
      if (!/^0x[0-9a-fA-F]{64}$/.test(args[0] || '')) throw new AgentError('Usage: cantorfi-agent sjothr reveal <poolId>')
      return module.reveal(app, args[0], (event) => console.error(`  ${event.step} → ${event.transaction}`))
    }
    case 'writer': {
      if (!/^(0x[0-9a-fA-F]{40}|none)$/.test(args[0] || '')) throw new AgentError('Usage: cantorfi-agent sjothr writer <wallet|none>')
      return module.setWriter(app, args[0], (event) => console.error(`  ${event.step} → ${event.transaction}`))
    }
    case 'progress': {
      const [file, campaignId] = args
      if (!file || (campaignId && !/^0x[0-9a-fA-F]{64}$/.test(campaignId))) throw new AgentError('Usage: cantorfi-agent sjothr progress <update.json> [campaignId]')
      return module.progress(app, json(await readFile(file, 'utf8'), 'The update'), campaignId, (event) => console.error(`  ${event.step} → ${event.transaction}`))
    }
    default: throw new AgentError('Usage: cantorfi-agent sjothr campaigns | rules | invest | portfolios | portfolio | positions | market | backer | founder | tribunal | code | vote | reveal | writer | progress | do. See: cantorfi-agent help')
  }
}

const commands = {
  help: async () => HELP,
  wallet: async () => {
    const { provider, wallet, contracts } = await context()
    const usdc = new ethers.Contract(contracts.tokens.USDC, ['function balanceOf(address) view returns (uint256)'], provider)
    const [tokens, gas] = await Promise.all([usdc.balanceOf(wallet.address), provider.getBalance(wallet.address)])
    return { address: wallet.address, network: contracts.network, chainId: contracts.chainId, usdc: ethers.formatUnits(tokens, 6), eth: ethers.formatEther(gas),
      keyKeptIn: KEY_KEPT_IN, note: 'USDC pays x402 desks without gas; ETH is needed only to send vault transactions.' }
  },
  discover: async () => {
    const door = await hello(DOOR)
    const [apps, vaults, paid] = await Promise.all([applications(), tool(DOOR, 'cantorfi_vaults'), tool(DOOR, 'cantorfi_paid_services').catch((error) => ({ unavailable: error.message }))])
    const reached = await Promise.all(apps.map(async (app) => ({ name: app.name, appId: app.appId, site: app.site, agentEndpoint: app.agentEndpoint,
      tools: app.agentEndpoint ? (await tools(app.agentEndpoint).catch(() => [])).map((entry) => entry.name) : [] })))
    return { door: DOOR, server: `${door.serverInfo.title || door.serverInfo.name} ${door.serverInfo.version}`, applications: reached,
      vaults: vaults.items.map((vault) => ({ token: vault.token, supplied: vault.supplied, borrowed: vault.borrowed, borrowAprPercent: vault.borrowAprPercent, maxBorrowPercent: vault.maxBorrowPercent })),
      paidServices: paid.services ? paid.services.map((service) => ({ id: service.id, price: service.price, resource: service.resource })) : paid }
  },
  position: async () => tool(DOOR, 'cantorfi_position', { wallet: (await context()).wallet.address }),
  supply: (vault, amount) => lend('supply', vault, amount),
  borrow: (vault, amount) => lend('borrow', vault, amount),
  repay: (vault, amount) => lend('repay', vault, amount),
  withdraw: (vault, amount) => lend('withdraw', vault, amount),
  stake: (vault, ...args) => staking('stake', vault, args),
  unstake: (vault) => staking('unstake', vault, []),
  'claim-rewards': (vault) => staking('claim_rewards', vault, []),
  swap: (from, to, amount, ...args) => swap(from, to, amount, args),
  services: async () => tool(DOOR, 'cantorfi_paid_services'),
  pay: async (id, input, ...rest) => {
    const paid = await tool(DOOR, 'cantorfi_paid_services')
    const service = paid.services.find((entry) => entry.id === id)
    if (!service) throw new AgentError(`Unknown service "${id || ''}"; see: cantorfi-agent services`)
    const { provider, wallet } = await context()
    const ceiling = flag(rest, 'max')
    const result = await payX402({ url: service.resource, body: json(input, 'The input'), wallet, provider,
      maxAtomic: ceiling ? ethers.parseUnits(ceiling, 6) : BigInt(service.priceAtomic), expect: { payTo: paid.payment.payTo, asset: paid.payment.asset, amount: service.priceAtomic } })
    return { status: result.status, paid: result.paid ? { ...result.paid, amount: `${ethers.formatUnits(result.paid.amountAtomic, 6)} USDC` } : null, result: result.body }
  },
  app: async (name, action, toolName, input) => {
    const app = await application(name)
    if (action === 'tools' || !action) return (await tools(app.agentEndpoint)).map((entry) => ({ name: entry.name, description: entry.description }))
    if (action === 'call' && toolName) return tool(app.agentEndpoint, toolName, json(input, 'The arguments'))
    throw new AgentError('Usage: cantorfi-agent app <name> tools | call <tool> [json]')
  },
  icare: (sub, ...args) => icare(sub, args),
  sjothr: (sub, ...args) => sjothr(sub, args),
}

const [name = 'help', ...args] = process.argv.slice(2)
const command = commands[name]
try {
  if (!command) throw new AgentError(`Unknown command "${name}". Try: cantorfi-agent help`)
  const result = await command(...args)
  if (result !== undefined) out(result)
  process.exit(process.exitCode ?? 0)
} catch (error) {
  console.error(error instanceof AgentError || error?.constructor?.name === 'IcareError' ? error.message : (error?.shortMessage || error?.message || String(error)))
  process.exit(1)
}

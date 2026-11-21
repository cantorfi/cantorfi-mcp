import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ethers } from 'ethers'
import { signTicket, buyTicketDirect, confirmTicket } from './payment.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const canonical = value => JSON.stringify(sort(value))
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]))
  return value
}
const digest = value => ethers.keccak256(ethers.toUtf8Bytes(canonical(value)))
function checkUrl(value) {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw Error('agent_url_invalid')
  return url.origin
}

export class TribunalAgent {
  constructor(config) {
    this.config = config
    this.api = checkUrl(config.apiUrl)
    if (!config.rpcUrl || !/^https?:$/.test(new URL(config.rpcUrl).protocol)) throw Error('agent_rpc_required')
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl)
    this.wallet = config.wallet
    if (!this.wallet?.signTypedData || !ethers.isAddress(config.escrow) || !ethers.isAddress(config.token) ||
        !Number.isSafeInteger(config.chainId) || config.chainId <= 0 || typeof config.maxBudgetAtomic !== 'bigint' || config.maxBudgetAtomic < 1_000_000n ||
        !Array.isArray(config.games) || !config.games.length || config.games.some(game => typeof game !== 'string' || !game.trim()) ||
        typeof config.analyze !== 'function' || !config.stateFile) throw Error('agent_configuration_invalid')
    this.identity = `${config.chainId}:${config.escrow.toLowerCase()}:${this.wallet.address.toLowerCase()}`
    this.log = config.log || console.log
    this.stateFile = path.resolve(config.stateFile)
    this.lockFile = this.stateFile + '.lock'
  }

  async initialize() {
    if (this.state) return
    if (Number((await this.provider.getNetwork()).chainId) !== this.config.chainId) throw Error('agent_chain_mismatch')
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true })
    if (!this.lock) {
      try { this.lock = await fs.open(this.lockFile, 'wx', 0o600) }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        let pid
        try { pid = Number(await fs.readFile(this.lockFile, 'utf8')); if (!Number.isSafeInteger(pid) || pid < 1) throw Error('agent_lock_invalid'); process.kill(pid, 0) }
        catch (probe) {
          if (probe.code !== 'ESRCH') throw Error('agent_already_running')
          await fs.unlink(this.lockFile)
          this.lock = await fs.open(this.lockFile, 'wx', 0o600)
        }
        if (!this.lock) throw Error('agent_already_running')
      }
      await this.lock.writeFile(String(process.pid))
    }
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'))
      if (state.version !== 1 || state.identity !== this.identity || !state.cases || typeof state.cases !== 'object' || Array.isArray(state.cases)) throw Error('agent_state_mismatch')
      for (const [key, item] of Object.entries(state.cases)) if (!UUID.test(key) || item.reservedAtomic !== '1000000') throw Error('agent_state_invalid')
      this.state = state
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      this.state = { version: 1, identity: this.identity, cases: {} }; await this.save()
    }
  }

  async save() {
    const pending = this.stateFile + '.pending'
    const file = await fs.open(pending, 'w', 0o600)
    try { await file.writeFile(JSON.stringify(this.state)); await file.sync() } finally { await file.close() }
    await fs.rename(pending, this.stateFile)
  }

  async request(route, body, headers = {}) {
    return fetch(this.api + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { accept: 'application/json', ...(this.session ? { authorization: `Bearer ${this.session.token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  }

  async bytes(response, limit) {
    let size = 0, chunks = []
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) throw Error('agent_response_too_large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  async json(response) {
    const value = JSON.parse((await this.bytes(response, 2 * 1024 * 1024)).toString())
    if (!response.ok) {
      if (response.status === 401) this.session = null
      throw Error(/^(tribunal|agent|x402)_[a-z_]+$/.test(value?.error) ? value.error : `agent_http_${response.status}`)
    }
    return value
  }

  async authenticate() {
    if (this.session?.exp > Date.now() + 30_000) return
    const wallet = this.wallet.address.toLowerCase()
    const challenge = await this.json(await this.request('/api/auth/challenge', { wallet }))
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce) || challenge.expiresAt <= Date.now()) throw Error('agent_challenge_invalid')
    const signature = await this.wallet.signMessage(`icare:session:${wallet}:${challenge.nonce}`)
    this.session = await this.json(await this.request('/api/auth/session', { wallet, nonce: challenge.nonce, signature }))
    if (typeof this.session.token !== 'string' || this.session.exp <= Date.now()) throw Error('agent_session_invalid')
  }

  verifyDossier(dossier) {
    if (!UUID.test(dossier.caseId) || !this.config.games.includes(dossier.question?.gameAppId) ||
        dossier.payment?.contract?.toLowerCase() !== this.config.escrow.toLowerCase() || dossier.payment?.token?.toLowerCase() !== this.config.token.toLowerCase() ||
        dossier.payment.chainId !== this.config.chainId || dossier.ticketPriceAtomic !== '1000000' ||
        !Array.isArray(dossier.proofs) || dossier.proofs.length < 1 || dossier.proofs.length > 160 ||
        dossier.closesAt - dossier.openedAt !== 300_000) throw Error('agent_dossier_invalid')
    if (digest({ rulesVersion: dossier.rulesVersion, question: dossier.question, arbiterVerdict: dossier.arbiterVerdict }) !== dossier.questionDigest ||
        digest({ evidenceRoot: dossier.evidenceRoot, claimsDigest: dossier.claimsDigest, proofs: dossier.proofs }) !== dossier.corpusDigest ||
        digest({ matchId: dossier.matchId, rulesVersion: dossier.rulesVersion, questionDigest: dossier.questionDigest,
          corpusDigest: dossier.corpusDigest, ticketPriceAtomic: dossier.ticketPriceAtomic, closesAt: dossier.closesAt }) !== dossier.payment.dossierHash ||
        digest({ deploymentId: dossier.deploymentId, caseId: dossier.caseId }) !== dossier.payment.caseKey) throw Error('agent_dossier_hash_mismatch')
  }

  response(dossier, answer, downloaded) {
    if (answer == null) return null
    const result = answer.result
    if (!['winner', 'insufficient_proof'].includes(result?.resolution) ||
        (result.resolution === 'winner' && (![1, 2].includes(result.winnerSide) ||
          ![result.score1, result.score2].every(n => Number.isInteger(n) && n >= 0 && n <= 255))) ||
        !Array.isArray(answer.proofs) || !answer.proofs.length || answer.proofs.length > 4) throw Error('agent_analysis_invalid')
    const proofs = answer.proofs.map(proof => {
      if (!downloaded.some(source => source.proofKey === proof.proofKey) || typeof proof.observation !== 'string' || !proof.observation.trim() || proof.observation.length > 2000) throw Error('agent_analysis_invalid')
      return { proofKey: proof.proofKey, observation: proof.observation.trim() }
    })
    if (new Set(proofs.map(proof => proof.proofKey)).size !== proofs.length) throw Error('agent_analysis_invalid')
    const normalized = result.resolution === 'insufficient_proof' ? { resolution: 'insufficient_proof' }
      : { resolution: 'winner', winnerSide: result.winnerSide, score1: result.score1, score2: result.score2 }
    if (dossier.arbiterVerdict && Object.entries(dossier.arbiterVerdict).every(([key, value]) => value == null || value === normalized[key])) return null
    return { beneficiary: this.wallet.address.toLowerCase(), result: normalized, proofs }
  }

  async processCase(dossier) {
    this.verifyDossier(dossier)
    const id = dossier.caseId, route = `/api/tribunal/cases/${id}`
    let item = this.state.cases[id]
    if (!item) {
      if (dossier.phase !== 'collecting' || !dossier.paymentAvailable || dossier.unavailable || dossier.closesAt < Date.now() + 20_000) return null
      const reserved = Object.values(this.state.cases).reduce((total, entry) => total + BigInt(entry.reservedAtomic), 0n)
      if (reserved + 1_000_000n > this.config.maxBudgetAtomic) { this.log({ caseId: id, status: 'budget_reached' }); return null }
      item = this.state.cases[id] = { reservedAtomic: '1000000', status: 'reserved' }
      await this.save() // Reserve durably before authorizing any USDC transfer.
    }
    let ticketResponse = await this.request(route + '/ticket', {})
    if (ticketResponse.status === 402) {
      if (ticketResponse.headers.has('PAYMENT-REQUIRED')) {
        const signature = await signTicket({ response: ticketResponse, dossier, wallet: this.wallet, provider: this.provider, ...this.config })
        await ticketResponse.body?.cancel()
        ticketResponse = await this.request(route + '/ticket', {}, { 'PAYMENT-SIGNATURE': signature })
      } else {
        const required = JSON.parse((await this.bytes(ticketResponse, 16_384)).toString())
        const hash = await buyTicketDirect({ required, dossier, wallet: this.wallet, provider: this.provider, ...this.config })
        if (hash) { item.transaction = hash; await this.save() }
        ticketResponse = await this.request(route + '/ticket', {})
      }
    }
    const receipt = await this.json(ticketResponse)
    const transaction = await confirmTicket({ response: ticketResponse, dossier, wallet: this.wallet, provider: this.provider, ...this.config })
    if (transaction) item.transaction = transaction
    item.status = receipt.outcome; await this.save()
    if (['won', 'lost'].includes(receipt.outcome)) {
      if (!item.payoutChecked) {
        item.payout = await this.json(await this.request(route + '/claim', {})); item.payoutChecked = true; await this.save()
      }
      return receipt
    }
    if (receipt.response || dossier.phase !== 'collecting' || item.abstained) return receipt
    if (!item.response) {
      const corpus = await this.json(await this.request(route + '/corpus'))
      if (corpus.caseId !== id || canonical(corpus.proofs) !== canonical(dossier.proofs) || corpus.corpusDigest !== dossier.corpusDigest) throw Error('agent_corpus_mismatch')
      const proofs = []
      for (const proof of corpus.proofs.slice(0, 4)) {
        if (proof.mediaType !== 'image/jpeg' || !Number.isSafeInteger(proof.bytes) || proof.bytes < 1 || proof.bytes > 1_048_576) throw Error('agent_proof_invalid')
        const response = await this.request(route + '/proof-file?key=' + encodeURIComponent(proof.proofKey))
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) throw Error('agent_proof_unavailable')
        const data = await this.bytes(response, 1_048_576)
        if (data.length !== proof.bytes || '0x' + createHash('sha256').update(data).digest('hex') !== proof.sha256) throw Error('agent_proof_hash_mismatch')
        proofs.push({ ...proof, data })
      }
      const answer = await this.config.analyze({ question: dossier.question, proofs })
      item.response = this.response(dossier, answer, proofs)
      item.abstained = item.response == null
      await this.save() // Persist the exact answer before POST; retries stay immutable.
    }
    if (item.abstained) { this.log({ caseId: id, status: 'abstained' }); return receipt }
    const submitted = await this.json(await this.request(route + '/response', item.response))
    item.status = submitted.outcome; item.sequence = submitted.sequence; await this.save()
    this.log({ caseId: id, status: item.status, transaction: item.transaction, sequence: item.sequence })
    return submitted
  }

  async runOnce() {
    if (this.running) throw Error('agent_already_running')
    this.running = true
    try {
      await this.initialize(); await this.authenticate()
      const { cases } = await this.json(await this.request('/api/tribunal/cases'))
      if (!Array.isArray(cases) || cases.length > 50) throw Error('agent_case_list_invalid')
      const ids = new Set([...Object.keys(this.state.cases), ...cases.filter(entry => this.config.games.includes(entry.question?.gameAppId) && entry.state === 'collecting').map(entry => entry.caseId)])
      const receipts = []
      for (const id of ids) {
        if (!UUID.test(id)) throw Error('agent_case_id_invalid')
        try {
          const dossier = await this.json(await this.request(`/api/tribunal/cases/${id}`))
          const receipt = await this.processCase(dossier)
          if (receipt) receipts.push(receipt)
        } catch (error) {
          this.log({ caseId: id, status: 'error', error: /^(agent|tribunal|x402)_[a-z_0-9]+$/.test(error.message) ? error.message : 'agent_operation_failed' })
          // Other cases can still be processed; expose failures to one-shot callers.
          receipts.push({ caseId: id, outcome: 'error', error: error.message })
        }
      }
      return receipts
    } finally { this.running = false }
  }

  async close() {
    if (this.lock) { await this.lock.close(); this.lock = null; await fs.unlink(this.lockFile).catch(() => {}) }
    this.provider.destroy()
  }
}

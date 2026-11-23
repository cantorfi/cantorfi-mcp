// The chain side of the agent: its provider (from the CantorFi door) and the sending of prepared transactions.
import { ethers } from 'ethers'
import { AgentError, DOOR, agentWallet } from './state.mjs'
import { tool } from './door.mjs'

let contextPromise = null
/** Network, contracts and wallet, read once from the door: { contracts, provider, wallet, allowed }. */
export function context() {
  return contextPromise ||= (async () => {
    const contracts = await tool(DOOR, 'cantorfi_contracts')
    const provider = new ethers.JsonRpcProvider(process.env.CANTORFI_RPC_URL || contracts.publicRpc, undefined, { batchMaxCount: 1, cacheTimeout: -1 })
    const { chainId } = await provider.getNetwork()
    if (Number(chainId) !== Number(contracts.chainId)) throw new AgentError(`The RPC is on chain ${chainId}, CantorFi runs on chain ${contracts.chainId}.`)
    // The agent only signs transactions to the vaults and tokens the door declares in its deployment manifest.
    const allowed = new Set(contracts.vaults.flatMap((vault) => [vault.vault.toLowerCase(), vault.tokenAddress.toLowerCase()]))
    return { contracts, provider, wallet: await agentWallet(provider), allowed }
  })().catch((error) => { contextPromise = null; throw error })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function retry(action, attempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await action() } catch (error) {
      if (attempt === attempts) throw error
      await sleep(1500 * attempt)
    }
  }
}

let nextNonce = 0
/** Signs and sends, in order, the transactions a door prepared for this wallet; returns the confirmed hashes.
 *  `also`: addresses an application module has checked itself (the contract registered for it on CantorFi). */
export async function signAndSend(prepared, log = () => {}, also = []) {
  const { provider, wallet, allowed } = await context()
  const { chainId } = await provider.getNetwork()
  if (BigInt(prepared.chainId) !== chainId) throw new AgentError(`Prepared for chain ${prepared.chainId}, the wallet is on chain ${chainId}: nothing was signed.`)
  const hashes = []
  for (const transaction of prepared.transactions) {
    if (transaction.from !== wallet.address) throw new AgentError('Prepared for another wallet: nothing was signed.')
    const target = String(transaction.to).toLowerCase()
    if (!allowed.has(target) && !also.some((address) => String(address).toLowerCase() === target)) throw new AgentError(`${transaction.to} is not a vault or a token of the CantorFi manifest: nothing was signed.`)
    const request = { to: transaction.to, data: transaction.data, value: BigInt(transaction.value) }
    const nonce = Math.max(nextNonce, await retry(() => provider.getTransactionCount(wallet.address, 'pending')))
    // A vault accrues interest once per second: the gas limit keeps a margin over the estimate.
    const estimate = await retry(() => provider.estimateGas({ ...request, from: wallet.address }))
    const sent = await wallet.sendTransaction({ ...request, nonce, gasLimit: estimate * 3n / 2n })
    nextNonce = nonce + 1
    const receipt = await retry(() => sent.wait())
    if (receipt.status !== 1) throw new AgentError(`"${transaction.description}" reverted: ${receipt.hash}`)
    log({ step: transaction.description, transaction: receipt.hash, block: receipt.blockNumber })
    hashes.push(receipt.hash)
  }
  return hashes
}

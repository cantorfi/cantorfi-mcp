// State of the single agent: one wallet, kept on this machine. The private key is created at first use and stored
// in the state file (mode 600); it signs locally and is never sent anywhere.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ethers } from 'ethers'

export const DIR = process.env.CANTORFI_AGENT_DIR || path.join(os.homedir(), '.cantorfi-agent')
export const STATE = path.join(DIR, 'state.json')
export const DOOR = (process.env.CANTORFI_DOOR_URL || 'https://www.cantorfi.xyz/api/mcp').replace(/\/+$/, '')
const ENV_KEY = /^(0x)?[0-9a-fA-F]{64}$/.test(process.env.CANTORFI_AGENT_PRIVATE_KEY || '') ? process.env.CANTORFI_AGENT_PRIVATE_KEY : null
export const KEY_KEPT_IN = ENV_KEY ? 'CANTORFI_AGENT_PRIVATE_KEY' : STATE

export class AgentError extends Error {}

export async function readState() {
  try { return JSON.parse(await fs.readFile(STATE, 'utf8')) } catch { return {} }
}
export async function saveState(next) {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 })
  await fs.writeFile(STATE, JSON.stringify(next, null, 2), { mode: 0o600 })
  await fs.chmod(STATE, 0o600)
}

let keyPromise = null
async function agentKey() {
  if (ENV_KEY) return ENV_KEY.startsWith('0x') ? ENV_KEY : `0x${ENV_KEY}`
  const saved = await readState()
  if (/^0x[0-9a-fA-F]{64}$/.test(saved.agentKey || '')) return saved.agentKey
  const key = ethers.Wallet.createRandom().privateKey
  await saveState({ ...saved, agentKey: key })
  return key
}
/** The agent's wallet, connected to the given provider. */
export async function agentWallet(provider) {
  keyPromise ||= agentKey().catch((error) => { keyPromise = null; throw error })
  return new ethers.Wallet(await keyPromise, provider)
}

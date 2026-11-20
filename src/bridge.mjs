#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// CantorFi MCP bridge: speaks MCP over stdio and forwards every message to the public
// CantorFi MCP endpoint (Streamable HTTP). No dependency, no key, read-only.
//
//   npx -y github:cantorfi/cantorfi-mcp

import { createInterface } from 'node:readline'

const ENDPOINT = process.env.CANTORFI_MCP_URL || 'https://www.cantorfi.xyz/api/mcp'
const NAME = 'CantorFi'

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function forward(line) {
  const text = line.trim()
  if (!text) return
  let message
  try { message = JSON.parse(text) } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: text,
      signal: AbortSignal.timeout(20_000),
    })
    // 202: the message was a notification, the server has nothing to answer.
    if (response.status === 202 || response.status === 204) return
    write(await response.json())
  } catch (error) {
    const id = message && !Array.isArray(message) ? message.id : null
    if (id !== undefined && id !== null) {
      write({ jsonrpc: '2.0', id, error: { code: -32000, message: `${NAME} MCP endpoint unreachable: ${error instanceof Error ? error.message : String(error)}` } })
    }
  }
}

// One message at a time, in the order received.
let queue = Promise.resolve()
createInterface({ input: process.stdin }).on('line', (line) => { queue = queue.then(() => forward(line)) })

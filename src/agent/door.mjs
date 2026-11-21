// Client of an agent door (MCP over HTTP, JSON answers): the CantorFi door and the door of each application it lists.
import { AgentError } from './state.mjs'

let id = 0
export async function rpc(url, method, params) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(40_000),
    })
  } catch { throw new AgentError(`${url} is unreachable, retry later.`) }
  if (!response.ok) throw new AgentError(`${url} answered HTTP ${response.status}.`)
  const text = await response.text()
  const reply = JSON.parse(text.startsWith('{') ? text : (text.split('\n').find((line) => line.startsWith('data:')) || 'data:{}').slice(5))
  if (reply.error) throw new AgentError(`${method}: ${reply.error.message}`)
  return reply.result
}
export async function hello(url) {
  return rpc(url, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cantorfi-agent', version: '0.3.0' } })
}
export async function tools(url) {
  return (await rpc(url, 'tools/list')).tools
}
/** Calls one tool and returns its structured result; a tool error becomes an AgentError. */
export async function tool(url, name, args = {}) {
  const result = await rpc(url, 'tools/call', { name, arguments: args })
  if (result.isError) throw new AgentError(result.content?.[0]?.text || `${name} failed.`)
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text || 'null')
}

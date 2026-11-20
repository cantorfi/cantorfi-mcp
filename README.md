# CantorFi MCP server

MCP server for [CantorFi](https://www.cantorfi.xyz), a lending protocol on Base made of isolated vaults: each vault lends one token against collateral in that same token, with borrow and supply rates derived from utilization. CantorFi also settles prediction markets and inspects B20 tokens.

With this server, Claude, ChatGPT, Gemini and any MCP client can read the live state of the vaults, the deployed contracts, the commands of the open-source liquidation bot and the CantorFi guides.

**Read-only. No key, no account, nothing signed.** Supplying, borrowing and liquidating stay in the user's own wallet, in the [application](https://app.cantorfi.xyz/yield) or the [liquidation bot](https://github.com/cantorfi/liquidation-bot).

## Connect

Remote server (Streamable HTTP, no authentication):

```
https://www.cantorfi.xyz/api/mcp
```

- **Claude (claude.ai, desktop, mobile)**: Settings → Connectors → Add custom connector, paste the URL.
- **ChatGPT**: Settings → Connectors (developer mode) → add the URL as an MCP server.
- **Claude Code**: `claude mcp add --transport http cantorfi https://www.cantorfi.xyz/api/mcp`
- **Clients configured with JSON** (remote):

```json
{ "mcpServers": { "cantorfi": { "url": "https://www.cantorfi.xyz/api/mcp" } } }
```

- **Clients that only launch local servers** (stdio): this repository is a small bridge with no dependency that forwards to the same endpoint. Node.js 20 or later.

```json
{ "mcpServers": { "cantorfi": { "command": "npx", "args": ["-y", "github:cantorfi/cantorfi-mcp"] } } }
```

## Tools

| Tool | What it returns |
| --- | --- |
| `cantorfi_vaults` | Every isolated lending vault: token, supplied, borrowed, available liquidity, utilization, borrow and supply APR, borrow limit, liquidation threshold and bonus. |
| `cantorfi_vault` | One vault, chosen by token symbol (`USDC`, `WETH`), vault id or vault address. |
| `cantorfi_contracts` | Network, chain id, deployment block and contract addresses: protocol registry, vault factory, reader, price oracle, and each vault with its token, receipt token and staking contract. |
| `cantorfi_liquidation_bot` | How to run the open-source liquidation bot, read-only or with your own wallet, with the commands filled with the network values. |
| `search` | Search vaults and guides (isolated lending, liquidations, prediction market settlement, B20 tokens, ERC-4626). |
| `fetch` | Full record of a vault or full text of a guide, by id from `search`. |

## Example questions

- "What are the borrow and supply rates on CantorFi right now?"
- "How much USDC can still be borrowed from the CantorFi USDC vault?"
- "Give me the CantorFi contract addresses on Base Sepolia."
- "How do I run a liquidation bot on CantorFi without risking a key?"
- "Explain how DeFi liquidations work, using the CantorFi guide."

## Status

The public deployment of CantorFi is a developer preview on Base Sepolia (chain id 84532). Rates are variable annualized estimates derived from utilization, not guaranteed yield.

## Links

- Website: https://www.cantorfi.xyz
- Application: https://app.cantorfi.xyz/yield
- Documentation: https://www.cantorfi.xyz/docs
- Liquidation bot: https://github.com/cantorfi/liquidation-bot
- Description for AI assistants: https://www.cantorfi.xyz/llms.txt

## License

MIT

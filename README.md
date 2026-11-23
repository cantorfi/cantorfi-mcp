# CantorFi agent and MCP server

MCP server for [CantorFi](https://www.cantorfi.xyz), a lending protocol on Base made of isolated vaults: each vault lends one token against collateral in that same token, with borrow and supply rates derived from utilization. CantorFi also settles prediction markets and inspects B20 tokens.

With this server, Claude, ChatGPT, Gemini and any MCP client can read the live state of the vaults, a wallet's position, the deployed contracts, the applications built on CantorFi, the commands of the open-source liquidation bot and the CantorFi guides. An agent that has its own wallet can also ask for the unsigned transactions of a vault action and sign them itself.

**No key, no account. The server never signs and never sends anything.** It reads the chain and prepares unsigned transactions; supplying, borrowing, repaying, withdrawing and liquidating are always signed by the user's or the agent's own wallet.

This repository holds two things that share one door, `https://www.cantorfi.xyz/api/mcp`:

- the **MCP server** of CantorFi, for Claude, ChatGPT, Gemini and any MCP client;
- the **CantorFi agent** (`cantorfi-agent`): one agent with its own wallet that works on CantorFi and on every application built on CantorFi. There is one agent, not one per application.

## The agent

```
npx -y -p github:cantorfi/cantorfi-mcp cantorfi-agent help
```

The agent connects to CantorFi only. There it finds the applications registered on CantorFi, reads the vaults and its own position, signs the transactions CantorFi prepares, and pays x402 desks in USDC.

| Command | What it does |
| --- | --- |
| `cantorfi-agent wallet` | Address and balances. The wallet is created on this machine at first use; its key never leaves it. |
| `cantorfi-agent discover` | Applications built on CantorFi with their own door, vaults, paid services. |
| `cantorfi-agent position` | What the wallet has supplied and owes in each vault. |
| `cantorfi-agent supply\|borrow\|repay\|withdraw <vault> <amount>` | CantorFi prepares the transactions, the wallet signs and sends them. |
| `cantorfi-agent services` | Paid services (x402) and their prices. |
| `cantorfi-agent pay <service id> '<json>'` | Pays a CantorFi service in USDC with x402: no gas, no approval, no account. |
| `cantorfi-agent app <name> tools` / `call <tool>` | Reads the door of any application registered on CantorFi. |
| `cantorfi-agent icare matches` / `bet` / `positions` / `sell` | ICARE predictions: stake paid from the ICARE Portfolio or with x402. |
| `cantorfi-agent icare auto run\|once\|status` | Autonomous loop: decides with your strategy, stakes within your limits, sells at your profit target, logs every action. |
| `cantorfi-agent icare tribunal list\|once\|run` | ICARE tribunal: 1 USDC ticket per case paid with x402, sealed proofs read, answer submitted. |
| `cantorfi-agent sjothr campaigns` / `rules` / `invest <campaignId> <usdc>` | Sjothr company raises: the raise is quoted by its contract, the wallet signs the allowance and the purchase; the 10% fee is paid by the backer on top. |

How it stays safe:

- One wallet, kept in `~/.cantorfi-agent/state.json` (mode 600) or given by `CANTORFI_AGENT_PRIVATE_KEY`. Nothing is ever sent but signatures.
- It signs a vault transaction only when it goes to a vault or a token of the CantorFi deployment manifest, on its own chain, from its own address.
- It pays an x402 desk only when the price fits the ceiling, the announced resource is the one it asked for, and the signing domain is the token's own on chain.
- It stakes on an ICARE match only while the match contract still accepts stakes, checked on chain before anything is signed or paid.
- It invests in a Sjothr raise only through an allowance in the USDC of the CantorFi manifest to the contract registered for Sjothr in the CantorFi registry, within your ceiling (`--max`), followed by the purchase on that same contract.

What is specific to an application lives in one module of this repository (`src/apps`). A new application registered on CantorFi is listed by `discover` at once and reachable with `app`; it gets a module only if it needs its own signatures.

The public deployment runs on Base Sepolia with test USDC (https://faucet.circle.com). Network, contracts, payment token and prices are read from the door, so the same agent follows CantorFi to Base mainnet.

## Connect the MCP server

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
| `cantorfi_apps` | Applications registered in the CantorFi integrator registry, read from the chain, with the endpoint where an agent reaches each of them. One connection finds them all. |
| `cantorfi_position` | What one wallet has supplied and owes in each vault: supply, debt with interest, what it can still borrow, what it can withdraw, health factor. |
| `cantorfi_prepare` | Unsigned transactions for one vault action (`supply`, `borrow`, `repay`, `withdraw`) and one amount, to be signed and sent in order by the wallet. |
| `cantorfi_paid_services` | Services paid per call in USDC with x402: resource, price, input, how to pay. |
| `search` | Search vaults and guides (isolated lending, liquidations, prediction market settlement, B20 tokens, ERC-4626). |
| `fetch` | Full record of a vault or full text of a guide, by id from `search`. |

## Example questions

- "What are the borrow and supply rates on CantorFi right now?"
- "How much USDC can still be borrowed from the CantorFi USDC vault?"
- "Give me the CantorFi contract addresses on Base Sepolia."
- "How do I run a liquidation bot on CantorFi without risking a key?"
- "What can an agent pay for on CantorFi, and how much?"
- "Which applications are built on CantorFi, and where does an agent reach them?"
- "What does my wallet 0x… owe on CantorFi?"
- "Prepare the transactions to supply 25 USDC to the CantorFi USDC vault from my wallet 0x…."
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

# Swish playground v3

This demo implements the v3 screens on the **Swish Playground Jayesh** page in Paper.

The page has two containers. The left container gives guidance for the current step. The right container holds the deposit widget. Only test funding, wallet setup help, and Demo Wallet approvals use dialogs.

## Code boundaries

- `src/widget/` is a demo-owned copy of the pay UI and deposit flow.
- `src/Session.tsx` controls the embedded flow, funding dialogs, and device links.
- `src/guide-copy.ts` contains the guide copy from Paper.
- `src/demo-wallet.ts` adds Demo Wallet beside Wallet Standard wallets.
- `server/` contains the new `/api/demo/` routes.
- The demo reuses the SDK API, passkey, wallet, encoding, and format clients.
- `apps/pay`, `packages/js`, and the main API routes do not need changes.

## Test funding

There are no invite codes or wallet claim limits. Each request sends **10 test USDC and 0.02 devnet SOL**. The server uses the canonical Circle devnet USDC mint. It checks the RPC genesis hash before it prepares or sends funds.

The bank key stays on the server. By default, the demo uses the faucet prototype's bank file at `~/.config/swish/devnet-bank.json`. The file must have mode `600` and contain a 64-byte Solana keypair array. Keep this bank funded with devnet USDC and SOL. No mainnet funds are used.

Optional server settings:

| Setting                     | Default                             | Purpose                                  |
| --------------------------- | ----------------------------------- | ---------------------------------------- |
| `DEMO_RPC_URL`              | `https://api.devnet.solana.com`     | Devnet RPC for funding and balance reads |
| `DEMO_FUNDING_KEYPAIR_FILE` | `~/.config/swish/devnet-bank.json`  | Dedicated devnet bank                    |
| `DEMO_FUNDING_JOURNAL`      | `~/.config/swish/demo-funding.json` | Persistent transfer records              |
| `DEMO_PUBLIC_ORIGIN`        | Current browser origin              | Shared HTTPS origin used in QR links     |

A funding request ID stays in browser storage until the transfer reaches a final result. The server saves the signed transaction before broadcast. A retry checks that transfer. It does not create a replacement while the result is uncertain. The journal serializes transfers within one server process. Use one demo server process per bank and journal.

Demo Wallet creates a real devnet wallet in browser storage. Its key is limited to this test wallet. Setup signatures require an explicit approval in the demo dialog. Later deposits use the real passkey flow.

## Device links

QR and Copy link open the same deposit on another device. The link has a random token and expires after ten minutes. The source screen pauses its challenge refresh and reads deposit status. The receiving device verifies the passkey, selects a linked wallet, and asks for a separate deposit approval.

Only one receiving device can hold the link at a time. `Use another device` releases it. The main Swish API provides the final result. Browser progress messages cannot mark a deposit successful.

Use any device where your same passkey is available.

A `localhost` link works only on the same computer. Phone tests require a shared HTTPS demo URL. The passkey RP ID must cover that host, the API must allow that origin, and the app registration must allow the demo origin. When `DEMO_PUBLIC_ORIGIN` is set, browser calls use `/api/swish` on the same public origin. The demo server forwards only the listed widget endpoints with its publishable key. `SWISH_API_URL` stays the internal API address. Setting `DEMO_PUBLIC_ORIGIN` alone does not create a tunnel or change passkey configuration.

Links and the demo deposit registry are in memory. A demo server restart ends existing device links. Funding transfer records persist in the journal.

## Routes

| Method | Path                                 | Purpose                                            |
| ------ | ------------------------------------ | -------------------------------------------------- |
| GET    | `/api/demo/funding/status`           | Check the bank and payout size                     |
| POST   | `/api/demo/funding/claims`           | Request funds with a wallet address and request ID |
| GET    | `/api/demo/funding/claims/:id`       | Check the same transfer                            |
| GET    | `/api/demo/wallets/:address`         | Read devnet USDC and SOL balances                  |
| POST   | `/api/demo/handoffs`                 | Create a device link for a demo deposit            |
| POST   | `/api/demo/handoffs/:token/open`     | Open the deposit on a receiving device             |
| POST   | `/api/demo/handoffs/:token/status`   | Read status with the source screen's owner key     |
| POST   | `/api/demo/handoffs/:token/progress` | Set progress or release the receiving device       |
| POST   | `/api/demo/handoffs/:token/cancel`   | Cancel the link with the owner key                 |

All new routes require the devnet configuration. Existing deposit, balance, webhook, and event routes keep their behavior.

## Checks

Run from `apps/demo`:

```sh
npm test
npm run typecheck
npm run build
```

Tests use fake RPC and wallet results. They do not send devnet transactions or create passkeys. Live passkey creation, wallet signatures, and phone tests need a person to complete the device prompts.

The backend loads server modules at startup. Restart the existing demo backend after server changes. Vite reloads browser code during local development.

## Temporary Cloudflare access

Serve the built demo backend through one tunnel:

```sh
cloudflared tunnel --url http://localhost:5183 --no-autoupdate
```

Set `DEMO_PUBLIC_ORIGIN` to the resulting HTTPS origin. Register that exact origin for the demo app. Set the API's `RP_ID` and the devnet program's passkey domain to the tunnel hostname. The on-chain domain change needs the program admin's approval. Restart the demo backend and API after their environment settings change.

Open the public URL on both devices. Create a new passkey at that URL. A passkey for `localhost` cannot approve deposits there. Keep the tunnel process running. A new tunnel gets a new hostname and requires new passkey setup.

To return to local tests, restore the previous API RP ID and devnet program passkey domain, remove `DEMO_PUBLIC_ORIGIN`, and restart the two backends. The prior domain settings for the current session are saved outside the repo in `~/.config/swish/demo-tunnel-20261009.json`.

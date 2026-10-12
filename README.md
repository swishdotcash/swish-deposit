# Swish Deposit

Link, for crypto. A user sets up once, then deposits into any Solana app with one Face ID or Touch ID.

> [!IMPORTANT]
> **Watch the 2-minute pitch:** [youtu.be/Iau7RB1Bcqw](https://youtu.be/Iau7RB1Bcqw) · [Deck](https://swish.cash/pitch)

[![Watch the Swish pitch](https://img.youtube.com/vi/Iau7RB1Bcqw/maxresdefault.jpg)](https://youtu.be/Iau7RB1Bcqw)

Depositing into a Solana app today means connecting a wallet, signing a message and approving a transaction, or copying an address by hand, every time. With Swish Deposit the user creates a passkey and sets a spending limit on their own wallet once. After that, a deposit into any app that uses the button is one passkey prompt. There is no wallet pop-up, and Swish never holds the funds.

**Try it:** [demo.swish.cash](https://demo.swish.cash). It runs on devnet with a demo wallet, so it needs no funds and no setup.

> Status: devnet only, and not audited. Do not use it with real funds.

## How it works

Two Solana programs do the work.

- **The Solana Foundation's allowance program.** The user sets a spending limit on their own wallet. The funds stay in the wallet.
- **The Swish Deposit program** (this repo, `programs/swish-deposit`). It links a passkey to that wallet, checks the passkey signature on chain, and pulls through the allowance.

The flow:

1. **Set up, once.** The user creates a passkey and approves a spending limit from their wallet. This links the wallet to a Swish ID.
2. **Deposit, every time after.** The app creates a deposit on its server. The user confirms with Face ID or Touch ID. The program verifies the signature and moves USDC from the user's wallet to the app's address, inside the limit.
3. **The app is told.** The app's server receives a `deposit.succeeded` webhook.

The user can change the limit or unlink the wallet at any time. Swish pays the network fees.

## For an app: one button, one API call

On your server, create a deposit with your secret key:

```sh
curl https://api.swish.cash/v1/deposits \
  -H "Authorization: Bearer swishsec_…" \
  -H "Content-Type: application/json" \
  -d '{"amount": "25", "token": "USDC", "destination": "<destination address in your app>"}'
```

On your page, mount the button with your publishable key:

```ts
import { mountDepositButton } from "@swishdotcash/deposit";

mountDepositButton("#deposit", {
  publishableKey: "swishpub_…",
  // your server: POST /v1/deposits with your secret key
  createDeposit: () => fetch("/deposits", { method: "POST" }).then((r) => r.json()),
  onSuccess: (deposit) => console.log("deposited", deposit),
});
```

The widget opens over your page in a frame served by Swish, so the user's passkey and wallet never touch your page. Treat the `deposit.succeeded` webhook, not the browser, as the source of truth.

`@swishdotcash/deposit` is not on npm yet. For now, build it from `packages/js`.

### Keys

| Key | Where it lives | What it can do |
|---|---|---|
| `swishpub_…` (publishable) | Your web page | Open the widget. Only works from origins you have registered. |
| `swishsec_…` (secret) | Your server only | Create and read deposits. |
| Client secret | Returned once per deposit | Lets the widget act on that one deposit. |

## What is in this repo

| Path | What it is |
|---|---|
| `programs/swish-deposit` | The Solana program (Anchor, Rust): link a wallet to a passkey, verify the passkey on chain, pull inside the limit. |
| `services/api` | The API (TypeScript, Express, Postgres): deposits, one-time setup, webhooks. |
| `packages/js` | `@swishdotcash/deposit`: the button and the loader for the widget. |
| `apps/pay` | The hosted frame the widget runs in (React, Vite). |
| `apps/demo` | The playground at demo.swish.cash (React, Vite). |
| `scripts` | Build, configure and initialise the program. |
| `docs` | Notes, including how to run against your own deployed program. |

## Run it locally

You need Node, a Postgres database, and a devnet RPC URL. Building the program also needs Rust and the Solana and Anchor toolchains.

```sh
npm install

# API
cd services/api
cp .env.example .env        # fill in the database, RPC and program values
npm run migrate
npm run register-app        # prints a publishable and a secret key
npm run dev

# Frame, in a second terminal
cd apps/pay && npm run dev

# Playground, in a third terminal
cd apps/demo
cp .env.example .env
npm run dev:server          # its small server
npm run dev                 # the page
```

Tests:

```sh
cd services/api && npm test
cd packages/js && npm test
npm run program:test        # from the repo root; builds and tests the program
```

To build or deploy the program under your own address, see [docs/local-program-id.md](docs/local-program-id.md).

## Deployed on devnet

| What | Where |
|---|---|
| Program | `D2JKE48xP76LQkr1fn41LM8nxG74uKohAXy5SEoPaL3p` |
| API | `https://api.swish.cash` |
| Frame | `https://pay.swish.cash` |
| Playground | `https://demo.swish.cash` |

## Hackathon note

Everything in this repo was built for the Colosseum Crypto World's Fair hackathon, starting on 28 September 2026. [Swish](https://swish.cash), our private payments app, has been live on Solana mainnet since January 2026 and is separate, prior work.

Two pieces exist only to serve the playground and are labelled `DEMO ONLY` in the code: the `GET /v1/deposits` list route in the API, and `/api/balance` in the playground's server. A real app should credit its users from the webhook.

The playground was built with Jayesh Potlabattini.

# Use your own Solana program

Each developer can use a different deployed Swish Deposit program. Set its address in your own `services/api/.env`:

```dotenv
SWISH_PROGRAM_ID=<your deployed program address>
```

The API and the `program:initialize` and `program:set-rp-id` scripts read this value. The demo and payment frame do not need a program ID; they call the API.

To build or test the program with this address, run these commands at the repository root:

```sh
npm run program:configure
npm run program:build
npm run program:test
```

`program:configure` writes a local `Anchor.toml` from `Anchor.toml.example`. Git ignores the local file. `program:build` also writes it, then compiles the Rust program with `SWISH_PROGRAM_ID` from the same `.env` file. The program address in `.env` must match the public key of the keypair used to deploy the program. Check the keypair with `solana-keygen pubkey <program-keypair-path>`.

Use a separate database for each program. Wallet links, app accounts, and deposit receipts use addresses derived from the program ID. An allowance or wallet link made for one program does not move to another program when you change this setting.

After you change `SWISH_PROGRAM_ID`, restart your API process. The change does not deploy or change a program on Solana.

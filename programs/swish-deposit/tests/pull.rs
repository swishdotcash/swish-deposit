//! End-to-end tests against the REAL Solana Foundation Subscriptions program
//! (both the mainnet and the devnet build, dumped into tests/fixtures), the
//! real SPL Token program and the real secp256r1 precompile.
//!
//! Build the program first (`npm run program:build`), then `cargo test`.

use anchor_lang::{
    error::ERROR_CODE_OFFSET,
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token;
use litesvm::LiteSVM;
use p256::ecdsa::{signature::Signer as _, Signature, SigningKey};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use subscriptions::{
    instructions::{
        CreateFixedDelegation, CreateFixedDelegationInstructionArgs, CreateRecurringDelegation,
        CreateRecurringDelegationInstructionArgs, InitSubscriptionAuthority,
    },
    types::{CreateFixedDelegationData, CreateRecurringDelegationData},
    EventAuthority, FixedDelegation, RecurringDelegation, SubscriptionAuthority, SUBSCRIPTIONS_ID,
};
use swish_deposit::{
    error::SwishError,
    state::{DepositReceipt, PullKind, SwishId},
    webauthn::{base64url_32, passkey_seed, PullChallenge},
    PullArgs, APP_SEED, CONFIG_SEED, PULLER_SEED, RECEIPT_SEED, SWISH_ID_SEED, WALLET_SEED,
};

const FOUNDATION_BUILDS: [(&str, &[u8]); 2] = [
    ("mainnet", include_bytes!("fixtures/subscriptions-mainnet.so")),
    ("devnet", include_bytes!("fixtures/subscriptions-devnet.so")),
];
const OURS: &[u8] = include_bytes!("../../../target/deploy/swish_deposit.so");

const NOW: i64 = 1_790_000_000;
const DECIMALS: u8 = 6;
const RP_ID: &str = "swish.cash";
const APP_ID: [u8; 16] = *b"demo-app-0000001";
const OTHER_APP_ID: [u8; 16] = *b"other-app-000002";
const ATA_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SECP256R1_PROGRAM: Pubkey = anchor_lang::pubkey!("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");
/// Two signatures (sponsor + wallet) at 5000 lamports each.
const TWO_SIGNATURE_FEE: u64 = 10_000;

fn units(n: u64) -> u64 {
    n * 10u64.pow(DECIMALS as u32)
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &swish_deposit::ID).0
}

fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), spl_token::ID.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}

fn custom(e: SwishError) -> u32 {
    ERROR_CODE_OFFSET + e as u32
}

fn new_passkey() -> SigningKey {
    SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng)
}

fn swish_id_address(passkey: &SigningKey) -> Pubkey {
    pda(&[SWISH_ID_SEED, &passkey_seed(&compressed(passkey))])
}

fn linked_wallet_address(wallet: &Pubkey) -> Pubkey {
    pda(&[WALLET_SEED, wallet.as_ref()])
}

fn receipt_address(deposit_id: &[u8; 16]) -> Pubkey {
    pda(&[RECEIPT_SEED, deposit_id])
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    sponsor: Keypair,
    mint: Pubkey,
    cluster_tag: [u8; 32],
    next_deposit: u64,
}

/// One wallet linked to a Swish ID, with its Foundation authority and allowance.
struct Wallet {
    kp: Keypair,
    ata: Pubkey,
    authority: Pubkey,
    delegation: Pubkey,
    kind: PullKind,
}

struct User {
    passkey: SigningKey,
    swish_id: Pubkey,
    wallets: Vec<Wallet>,
}

impl Env {
    fn new(foundation: &[u8]) -> Self {
        let mut svm = new_svm();
        svm.add_program(SUBSCRIPTIONS_ID, foundation).unwrap();
        svm.add_program(swish_deposit::ID, OURS).unwrap();
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW;
        clock.slot = 1_000;
        svm.set_sysvar(&clock);

        let admin = Keypair::new();
        let sponsor = Keypair::new();
        svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
        svm.airdrop(&sponsor.pubkey(), 10_000_000_000).unwrap();
        set_upgrade_authority(&mut svm, &admin.pubkey());

        let mint = Pubkey::new_unique();
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint {
            mint_authority: Some(admin.pubkey()).into(),
            supply: units(1_000_000),
            decimals: DECIMALS,
            is_initialized: true,
            freeze_authority: None.into(),
        }
        .pack_into_slice(&mut data);
        set_owned(&mut svm, mint, spl_token::ID, data);

        let mut env = Env { svm, admin, sponsor, mint, cluster_tag: [7u8; 32], next_deposit: 0 };

        let admin_key = env.admin.pubkey();
        let initialize = env.ix(
            swish_deposit::accounts::Initialize {
                authority: admin_key,
                config: pda(&[CONFIG_SEED]),
                program: swish_deposit::ID,
                program_data: program_data_address(),
                system_program: system_program::ID,
            },
            swish_deposit::instruction::Initialize {
                args: swish_deposit::InitializeArgs {
                    admin: admin_key,
                    cluster_tag: env.cluster_tag,
                    rp_id_hash: Sha256::digest(RP_ID).into(),
                },
            },
        );
        env.send_as_admin(&[initialize]).unwrap();
        env.register_app(APP_ID);
        env
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    fn send_as_admin(&mut self, ixs: &[Instruction]) -> Result<(), String> {
        let admin = self.admin.insecure_clone();
        self.send(ixs, &[&admin])
    }

    /// The sponsor pays; `extra` sign too (e.g. the user's wallet).
    fn send_sponsored(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<(), String> {
        let sponsor = self.sponsor.insecure_clone();
        let mut signers = vec![&sponsor];
        signers.extend_from_slice(extra);
        self.send(ixs, &signers)
    }

    fn ix<A: ToAccountMetas, D: InstructionData>(&self, accounts: A, data: D) -> Instruction {
        Instruction::new_with_bytes(swish_deposit::ID, &data.data(), accounts.to_account_metas(None))
    }

    fn register_app(&mut self, app_id: [u8; 16]) {
        let register = self.ix(
            swish_deposit::accounts::RegisterApp {
                admin: self.admin.pubkey(),
                config: pda(&[CONFIG_SEED]),
                app: pda(&[APP_SEED, &app_id]),
                system_program: system_program::ID,
            },
            swish_deposit::instruction::RegisterApp { app_id },
        );
        self.send_as_admin(&[register]).unwrap();
    }

    /// A user's own account inside an app (e.g. their embedded wallet there):
    /// where a deposit lands.
    fn app_account(&mut self) -> Pubkey {
        let owner = Pubkey::new_unique();
        let address = ata(&owner, &self.mint);
        set_token_account(&mut self.svm, address, self.mint, owner, 0);
        address
    }

    /// A user with one linked wallet holding `balance`, allowance `allowance`.
    fn new_user(&mut self, balance: u64, allowance: u64, kind: PullKind) -> User {
        let passkey = new_passkey();
        let mut user = User { swish_id: swish_id_address(&passkey), passkey, wallets: vec![] };
        self.add_wallet(&mut user, balance, allowance, kind);
        user
    }

    /// The one-time setup for one wallet: Foundation authority, an allowance
    /// naming our puller, and linking the wallet to the user's Swish ID.
    fn add_wallet(&mut self, user: &mut User, balance: u64, allowance: u64, kind: PullKind) {
        let kp = Keypair::new();
        let wallet = kp.pubkey();
        let user_ata = ata(&wallet, &self.mint);
        set_token_account(&mut self.svm, user_ata, self.mint, wallet, balance);
        let (authority, _) = SubscriptionAuthority::find_pda(&wallet, &self.mint);
        let puller = pda(&[PULLER_SEED]);
        let (delegation, _) = FixedDelegation::find_pda(&authority, &wallet, &puller, 0);

        let init = InitSubscriptionAuthority {
            owner: wallet,
            subscription_authority: authority,
            token_mint: self.mint,
            user_ata,
            system_program: system_program::ID,
            token_program: spl_token::ID,
            payer: Some(self.sponsor.pubkey()),
        }
        .instruction();
        self.send_sponsored(&[init], &[&kp]).unwrap();
        let init_id = {
            let acc = self.svm.get_account(&authority).unwrap();
            SubscriptionAuthority::from_bytes(&acc.data).unwrap().init_id
        };

        let create = match kind {
            PullKind::Fixed => CreateFixedDelegation {
                delegator: wallet,
                subscription_authority: authority,
                delegation_account: delegation,
                delegatee: puller,
                system_program: system_program::ID,
                payer: Some(self.sponsor.pubkey()),
            }
            .instruction(CreateFixedDelegationInstructionArgs {
                fixed_delegation: CreateFixedDelegationData {
                    nonce: 0,
                    amount: allowance,
                    expiry_ts: 0,
                    expected_subscription_authority_init_id: init_id,
                },
            }),
            PullKind::Recurring => CreateRecurringDelegation {
                delegator: wallet,
                subscription_authority: authority,
                delegation_account: RecurringDelegation::find_pda(&authority, &wallet, &puller, 0).0,
                delegatee: puller,
                system_program: system_program::ID,
                payer: Some(self.sponsor.pubkey()),
            }
            .instruction(CreateRecurringDelegationInstructionArgs {
                recurring_delegation: CreateRecurringDelegationData {
                    nonce: 0,
                    amount_per_period: allowance,
                    period_length_s: 86_400,
                    start_ts: NOW,
                    expiry_ts: 0,
                    expected_subscription_authority_init_id: init_id,
                },
            }),
        };
        let link = self.link_ix(&wallet, &user.passkey);
        self.send_sponsored(&[create, link], &[&kp]).unwrap();

        user.wallets.push(Wallet { kp, ata: user_ata, authority, delegation, kind });
    }

    fn link_ix(&self, wallet: &Pubkey, passkey: &SigningKey) -> Instruction {
        self.ix(
            swish_deposit::accounts::LinkWallet {
                wallet: *wallet,
                payer: self.sponsor.pubkey(),
                swish_id: swish_id_address(passkey),
                linked_wallet: linked_wallet_address(wallet),
                system_program: system_program::ID,
            },
            swish_deposit::instruction::LinkWallet { passkey: compressed(passkey) },
        )
    }

    fn unlink_ix(&self, user: &User, wallet: &Wallet) -> Instruction {
        self.ix(
            swish_deposit::accounts::UnlinkWallet {
                wallet: wallet.kp.pubkey(),
                linked_wallet: linked_wallet_address(&wallet.kp.pubkey()),
                swish_id: user.swish_id,
                rent_payer: self.sponsor.pubkey(),
            },
            swish_deposit::instruction::UnlinkWallet {},
        )
    }

    fn balance(&self, token_account: &Pubkey) -> u64 {
        let acc = self.svm.get_account(token_account).unwrap();
        spl_token::state::Account::unpack(&acc.data).unwrap().amount
    }

    fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map_or(0, |a| a.lamports)
    }

    fn exists(&self, address: &Pubkey) -> bool {
        self.svm.get_account(address).is_some_and(|a| a.lamports > 0)
    }

    fn set_paused(&mut self, paused: bool) {
        let ix = self.ix(
            swish_deposit::accounts::AdminOnly { admin: self.admin.pubkey(), config: pda(&[CONFIG_SEED]) },
            swish_deposit::instruction::SetPaused { paused },
        );
        self.send_as_admin(&[ix]).unwrap();
    }

    fn retire_ix(&self, authority: &Pubkey) -> Instruction {
        self.ix(
            swish_deposit::accounts::Retire {
                authority: *authority,
                config: pda(&[CONFIG_SEED]),
                program: swish_deposit::ID,
                program_data: program_data_address(),
            },
            swish_deposit::instruction::Retire {},
        )
    }

    fn close_receipt_ix(&self, deposit_id: &[u8; 16], rent_payer: &Pubkey) -> Instruction {
        self.ix(
            swish_deposit::accounts::CloseReceipt {
                config: pda(&[CONFIG_SEED]),
                receipt: receipt_address(deposit_id),
                rent_payer: *rent_payer,
            },
            swish_deposit::instruction::CloseReceipt {},
        )
    }

    fn warp(&mut self, seconds: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += seconds;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }

    fn fresh_deposit_id(&mut self) -> [u8; 16] {
        self.next_deposit += 1;
        let mut id = [0u8; 16];
        id[..8].copy_from_slice(&self.next_deposit.to_le_bytes());
        id
    }
}

/// Everything a deposit is made of. Tests build one, let the user's passkey
/// sign it, then tamper with either side.
#[derive(Clone)]
struct Deposit {
    deposit_id: [u8; 16],
    kind: PullKind,
    amount: u64,
    expires_at: i64,
    app_id: [u8; 16],
    receiver: Pubkey,
    swish_id: Pubkey,
    wallet: Pubkey,
    source: Pubkey,
    authority: Pubkey,
    delegation: Pubkey,
}

/// A deposit of `amount` from the user's wallet number `w` into `receiver`.
fn deposit(env: &mut Env, user: &User, w: usize, amount: u64, receiver: Pubkey) -> Deposit {
    let wallet = &user.wallets[w];
    let puller = pda(&[PULLER_SEED]);
    let delegation = match wallet.kind {
        PullKind::Fixed => wallet.delegation,
        PullKind::Recurring => {
            RecurringDelegation::find_pda(&wallet.authority, &wallet.kp.pubkey(), &puller, 0).0
        }
    };
    let now: Clock = env.svm.get_sysvar();
    Deposit {
        deposit_id: env.fresh_deposit_id(),
        kind: wallet.kind,
        amount,
        expires_at: now.unix_timestamp + 60,
        app_id: APP_ID,
        receiver,
        swish_id: user.swish_id,
        wallet: wallet.kp.pubkey(),
        source: wallet.ata,
        authority: wallet.authority,
        delegation,
    }
}

fn challenge(env: &Env, d: &Deposit) -> [u8; 32] {
    PullChallenge {
        cluster_tag: &env.cluster_tag,
        program_id: &swish_deposit::ID,
        deposit_id: &d.deposit_id,
        app_id: &d.app_id,
        mint: &env.mint,
        destination: &d.receiver,
        amount: d.amount,
        expires_at: d.expires_at,
    }
    .hash()
}

/// How the browser's passkey behaves. Tests change one thing at a time.
struct Assertion {
    signer: SigningKey,
    rp_id: String,
    flags: u8,
    client_type: &'static str,
    high_s: bool,
}

impl Assertion {
    fn by(signer: &SigningKey) -> Self {
        Self { signer: signer.clone(), rp_id: RP_ID.into(), flags: 0x05, client_type: "webauthn.get", high_s: false }
    }
}

/// What the browser hands back from `navigator.credentials.get`.
struct Signed {
    passkey: [u8; 33],
    signature: [u8; 64],
    message: Vec<u8>,
    client_data_json: Vec<u8>,
}

fn sign(env: &Env, d: &Deposit, a: &Assertion) -> Signed {
    let client_data_json = format!(
        r#"{{"type":"{}","challenge":"{}","origin":"https://use.swish.cash","crossOrigin":false}}"#,
        a.client_type,
        std::str::from_utf8(&base64url_32(&challenge(env, d))).unwrap()
    )
    .into_bytes();
    let mut authenticator_data = Sha256::digest(a.rp_id.as_bytes()).to_vec();
    authenticator_data.push(a.flags);
    authenticator_data.extend_from_slice(&[0, 0, 0, 0]);
    let mut message = authenticator_data;
    message.extend_from_slice(&Sha256::digest(&client_data_json));

    let signature: Signature = a.signer.sign(&message);
    let signature = signature.normalize_s().unwrap_or(signature);
    let mut bytes: [u8; 64] = signature.to_bytes().into();
    if a.high_s {
        let high = negate_s(&bytes[32..]);
        bytes[32..].copy_from_slice(&high);
    }
    Signed { passkey: compressed(&a.signer), signature: bytes, message, client_data_json }
}

fn precompile_ix(s: &Signed, index: u16) -> Instruction {
    let pubkey_offset = 16u16;
    let signature_offset = pubkey_offset + 33;
    let message_offset = signature_offset + 64;
    let mut data = vec![1u8, 0];
    for v in [signature_offset, index, pubkey_offset, index, message_offset, s.message.len() as u16, index] {
        data.extend_from_slice(&v.to_le_bytes());
    }
    data.extend_from_slice(&s.passkey);
    data.extend_from_slice(&s.signature);
    data.extend_from_slice(&s.message);
    Instruction { program_id: SECP256R1_PROGRAM, accounts: vec![], data }
}

fn pull_ix(env: &Env, d: &Deposit, client_data_json: Vec<u8>) -> Instruction {
    env.ix(
        swish_deposit::accounts::Pull {
            payer: env.sponsor.pubkey(),
            config: pda(&[CONFIG_SEED]),
            app: pda(&[APP_SEED, &d.app_id]),
            swish_id: d.swish_id,
            linked_wallet: linked_wallet_address(&d.wallet),
            receipt: receipt_address(&d.deposit_id),
            puller: pda(&[PULLER_SEED]),
            delegation: d.delegation,
            subscription_authority: d.authority,
            source: d.source,
            receiver: d.receiver,
            mint: env.mint,
            token_program: spl_token::ID,
            subscriptions_event_authority: EventAuthority::find_pda().0,
            subscriptions_program: SUBSCRIPTIONS_ID,
            instructions: INSTRUCTIONS_SYSVAR,
            system_program: system_program::ID,
        },
        swish_deposit::instruction::Pull {
            args: PullArgs {
                deposit_id: d.deposit_id,
                kind: d.kind,
                amount: d.amount,
                expires_at: d.expires_at,
                client_data_json,
            },
        },
    )
}

/// The normal path: sign exactly `d`, submit exactly `d`, the sponsor pays.
fn submit(env: &mut Env, d: &Deposit, a: &Assertion) -> Result<(), String> {
    let s = sign(env, d, a);
    submit_signed(env, d, &s)
}

fn submit_signed(env: &mut Env, d: &Deposit, s: &Signed) -> Result<(), String> {
    let ixs = [precompile_ix(s, u16::MAX), pull_ix(env, d, s.client_data_json.clone())];
    env.send_sponsored(&ixs, &[])
}

fn assert_error(res: Result<(), String>, e: SwishError) {
    let code = custom(e);
    let err = res.expect_err("expected the transaction to fail");
    assert!(err.contains(&format!("Custom({code})")), "expected {e:?} ({code}), got: {err}");
}

// ---- helpers for raw accounts ----

fn compressed(key: &SigningKey) -> [u8; 33] {
    key.verifying_key().to_encoded_point(true).as_bytes().try_into().unwrap()
}

fn negate_s(s: &[u8]) -> [u8; 32] {
    use p256::elliptic_curve::{bigint::Encoding, Curve};
    let n = p256::NistP256::ORDER.to_be_bytes();
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let v = n[i] as i16 - s[i] as i16 - borrow;
        borrow = if v < 0 { 1 } else { 0 };
        out[i] = v.rem_euclid(256) as u8;
    }
    out
}

fn set_owned(svm: &mut LiteSVM, address: Pubkey, owner: Pubkey, data: Vec<u8>) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(address, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
}

fn set_token_account(svm: &mut LiteSVM, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint,
        owner,
        amount,
        delegate: None.into(),
        state: spl_token::state::AccountState::Initialized,
        is_native: None.into(),
        delegated_amount: 0,
        close_authority: None.into(),
    }
    .pack_into_slice(&mut data);
    set_owned(svm, address, spl_token::ID, data);
}

/// LiteSVM 0.10 ships the old rent (3480 lamports/byte-year, threshold 2).
/// Mainnet and devnet now charge 5080 lamports per byte, flat, and the
/// Foundation program sizes its accounts for that; use what the chain uses.
fn new_svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    #[allow(deprecated)]
    svm.set_sysvar(&anchor_lang::prelude::Rent {
        lamports_per_byte_year: 5080,
        exemption_threshold: 1.0,
        burn_percent: 50,
    });
    svm
}

fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(
        &[swish_deposit::ID.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
    )
    .0
}

/// LiteSVM deploys with no upgrade authority; set one, as a real deploy has.
fn set_upgrade_authority(svm: &mut LiteSVM, authority: &Pubkey) {
    let address = program_data_address();
    let mut acc = svm.get_account(&address).unwrap();
    // UpgradeableLoaderState::ProgramData = u32 tag, u64 slot, Option<Pubkey>.
    acc.data[12] = 1;
    acc.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(address, acc).unwrap();
}

/// Runs a test body once per Foundation build.
fn each_build(body: impl Fn(&str, &[u8])) {
    for (name, bytes) in FOUNDATION_BUILDS {
        body(name, bytes);
    }
}

fn mainnet() -> Env {
    Env::new(FOUNDATION_BUILDS[0].1)
}

// ---- deposits ----

#[test]
fn one_face_id_moves_money_into_the_users_own_app_account() {
    each_build(|build, foundation| {
        let mut env = Env::new(foundation);
        let user = env.new_user(units(100), units(50), PullKind::Fixed);
        let in_app = env.app_account();
        let d = deposit(&mut env, &user, 0, units(20), in_app);
        submit(&mut env, &d, &Assertion::by(&user.passkey)).unwrap_or_else(|e| panic!("{build}: {e}"));

        assert_eq!(env.balance(&user.wallets[0].ata), units(80), "{build}");
        assert_eq!(env.balance(&in_app), units(20), "{build}");
        let delegation = env.svm.get_account(&user.wallets[0].delegation).unwrap();
        assert_eq!(FixedDelegation::from_bytes(&delegation.data).unwrap().amount, units(30), "{build}");
        let receipt = env.svm.get_account(&receipt_address(&d.deposit_id)).unwrap();
        let receipt = DepositReceipt::try_deserialize(&mut receipt.data.as_slice()).unwrap();
        assert_eq!(receipt.expires_at, d.expires_at, "{build}");
        assert_eq!(receipt.rent_payer, env.sponsor.pubkey(), "{build}");
        let expected = PullChallenge {
            cluster_tag: &env.cluster_tag, program_id: &swish_deposit::ID,
            deposit_id: &d.deposit_id, app_id: &d.app_id, mint: &env.mint,
            destination: &d.receiver, amount: d.amount, expires_at: d.expires_at,
        }.payment_commitment();
        assert_eq!(receipt.commitment, expected, "{build}");
        assert_eq!(receipt.wallet, d.wallet, "{build}");
        assert_eq!(receipt.swish_id, user.swish_id, "{build}");
    });
}

#[test]
fn a_recurring_allowance_can_be_pulled_too() {
    each_build(|build, foundation| {
        let mut env = Env::new(foundation);
        let user = env.new_user(units(100), units(10), PullKind::Recurring);
        let in_app = env.app_account();
        let d = deposit(&mut env, &user, 0, units(10), in_app);
        submit(&mut env, &d, &Assertion::by(&user.passkey)).unwrap_or_else(|e| panic!("{build}: {e}"));
        assert_eq!(env.balance(&in_app), units(10), "{build}");

        // The period's cap is spent: one more unit in the same period fails.
        let again = deposit(&mut env, &user, 0, 1, in_app);
        assert!(submit(&mut env, &again, &Assertion::by(&user.passkey)).is_err(), "{build}");
    });
}

#[test]
fn one_swish_id_deposits_from_any_of_its_wallets_each_within_its_own_limit() {
    let mut env = mainnet();
    let mut user = env.new_user(units(100), units(50), PullKind::Fixed);
    env.add_wallet(&mut user, units(100), units(10), PullKind::Fixed);
    assert_eq!(user.wallets.len(), 2);
    let swish_id = env.svm.get_account(&user.swish_id).unwrap();
    assert_eq!(SwishId::try_deserialize(&mut swish_id.data.as_slice()).unwrap().linked_wallets, 2);

    let in_app = env.app_account();
    let from_first = deposit(&mut env, &user, 0, units(40), in_app);
    submit(&mut env, &from_first, &Assertion::by(&user.passkey)).unwrap();
    let from_second = deposit(&mut env, &user, 1, units(10), in_app);
    submit(&mut env, &from_second, &Assertion::by(&user.passkey)).unwrap();
    assert_eq!(env.balance(&in_app), units(50));

    // The second wallet's own limit (10) is spent; the first still has 10.
    let over = deposit(&mut env, &user, 1, 1, in_app);
    assert!(submit(&mut env, &over, &Assertion::by(&user.passkey)).is_err());
    let rest = deposit(&mut env, &user, 0, units(10), in_app);
    submit(&mut env, &rest, &Assertion::by(&user.passkey)).unwrap();
}

#[test]
fn a_deposit_id_works_once() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    submit_signed(&mut env, &d, &s).unwrap();
    assert!(submit_signed(&mut env, &d, &s).is_err(), "the receipt already exists");
    assert_eq!(env.balance(&in_app), units(5));
}

#[test]
fn nothing_the_passkey_signed_can_be_changed() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    env.register_app(OTHER_APP_ID);
    let in_app = env.app_account();
    let elsewhere = env.app_account();
    let signed_for = deposit(&mut env, &user, 0, units(5), in_app);
    let s = sign(&env, &signed_for, &Assertion::by(&user.passkey));

    let mut more = signed_for.clone();
    more.amount = units(50);
    assert_error(submit_signed(&mut env, &more, &s), SwishError::ChallengeMismatch);

    let mut other_account = signed_for.clone();
    other_account.receiver = elsewhere;
    assert_error(submit_signed(&mut env, &other_account, &s), SwishError::ChallengeMismatch);

    let mut other_app = signed_for.clone();
    other_app.app_id = OTHER_APP_ID;
    assert_error(submit_signed(&mut env, &other_app, &s), SwishError::ChallengeMismatch);

    let mut later = signed_for.clone();
    later.expires_at += 30;
    assert_error(submit_signed(&mut env, &later, &s), SwishError::ChallengeMismatch);

    let mut other_id = signed_for.clone();
    other_id.deposit_id = [9u8; 16];
    assert_error(submit_signed(&mut env, &other_id, &s), SwishError::ChallengeMismatch);

    assert_eq!(env.balance(&user.wallets[0].ata), units(100));
}

#[test]
fn only_the_swish_ids_own_passkey_works() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    assert_error(submit(&mut env, &d, &Assertion::by(&new_passkey())), SwishError::WrongPasskey);
}

#[test]
fn a_swish_id_cannot_pull_from_a_wallet_it_did_not_link() {
    let mut env = mainnet();
    let alice = env.new_user(units(100), units(50), PullKind::Fixed);
    let bob = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    // Alice's Swish ID and Face ID, Bob's wallet, allowance and tokens.
    let mut d = deposit(&mut env, &bob, 0, units(5), in_app);
    d.swish_id = alice.swish_id;
    assert_error(submit(&mut env, &d, &Assertion::by(&alice.passkey)), SwishError::WalletNotLinked);
    assert_eq!(env.balance(&bob.wallets[0].ata), units(100));
}

#[test]
fn someone_elses_allowance_cannot_be_used() {
    let mut env = mainnet();
    let alice = env.new_user(units(100), units(50), PullKind::Fixed);
    let bob = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    // Alice's Swish ID, wallet and tokens, Bob's allowance.
    let mut d = deposit(&mut env, &alice, 0, units(5), in_app);
    d.delegation = bob.wallets[0].delegation;
    d.authority = bob.wallets[0].authority;
    assert_error(submit(&mut env, &d, &Assertion::by(&alice.passkey)), SwishError::WrongDelegation);

    // Bob's token account too: the account checks refuse before anything moves.
    d.source = bob.wallets[0].ata;
    assert!(submit(&mut env, &d, &Assertion::by(&alice.passkey)).is_err());
    assert_eq!(env.balance(&bob.wallets[0].ata), units(100));
}

#[test]
fn the_allowance_caps_every_pull() {
    each_build(|build, foundation| {
        let mut env = Env::new(foundation);
        let user = env.new_user(units(100), units(50), PullKind::Fixed);
        let in_app = env.app_account();
        let d = deposit(&mut env, &user, 0, units(51), in_app);
        assert!(submit(&mut env, &d, &Assertion::by(&user.passkey)).is_err(), "{build}");
        assert_eq!(env.balance(&user.wallets[0].ata), units(100), "{build}");
    });
}

// ---- the passkey check ----

#[test]
fn a_pull_without_a_signature_check_before_it_fails() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    let ix = pull_ix(&env, &d, s.client_data_json.clone());
    assert_error(env.send_sponsored(&[ix], &[]), SwishError::MissingPasskeySignature);
}

#[test]
fn a_signature_check_must_carry_its_own_data() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    // Offsets pointing at instruction 0 (itself, by index rather than by
    // u16::MAX): the precompile accepts it, we must not.
    let ixs = [precompile_ix(&s, 0), pull_ix(&env, &d, s.client_data_json.clone())];
    assert_error(env.send_sponsored(&ixs, &[]), SwishError::MalformedPasskeySignature);
}

#[test]
fn one_signature_check_cannot_cover_two_pulls() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    let mut second = d.clone();
    second.deposit_id = env.fresh_deposit_id();
    let ixs = [
        precompile_ix(&s, u16::MAX),
        pull_ix(&env, &d, s.client_data_json.clone()),
        pull_ix(&env, &second, s.client_data_json.clone()),
    ];
    assert_error(env.send_sponsored(&ixs, &[]), SwishError::MissingPasskeySignature);
    assert_eq!(env.balance(&user.wallets[0].ata), units(100));
}

#[test]
fn face_id_must_have_verified_the_user() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let mut a = Assertion::by(&user.passkey);
    a.flags = 0x01; // present, not verified
    assert_error(submit(&mut env, &d, &a), SwishError::UserNotVerified);
}

#[test]
fn a_passkey_signature_for_another_site_is_refused() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let mut a = Assertion::by(&user.passkey);
    a.rp_id = "evil.example".into();
    assert_error(submit(&mut env, &d, &a), SwishError::WrongRelyingParty);
}

#[test]
fn a_registration_signature_is_not_a_deposit_approval() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let mut a = Assertion::by(&user.passkey);
    a.client_type = "webauthn.create";
    assert_error(submit(&mut env, &d, &a), SwishError::ChallengeMismatch);
}

#[test]
fn client_data_must_match_what_was_signed() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let mut s = sign(&env, &d, &Assertion::by(&user.passkey));
    s.client_data_json.push(b' ');
    assert_error(submit_signed(&mut env, &d, &s), SwishError::ClientDataMismatch);
}

#[test]
fn a_high_s_signature_is_refused_by_the_runtime() {
    // Browsers can return either form; the client must normalise to low-S.
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let mut a = Assertion::by(&user.passkey);
    a.high_s = true;
    assert!(submit(&mut env, &d, &a).is_err());
}

#[test]
fn signatures_expire() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    env.warp(61);
    assert_error(submit_signed(&mut env, &d, &s), SwishError::SignatureExpired);

    let mut far = deposit(&mut env, &user, 0, units(5), in_app);
    far.expires_at += 121;
    assert_error(submit(&mut env, &far, &Assertion::by(&user.passkey)), SwishError::DeadlineTooFar);
}

// ---- switches ----

#[test]
fn pause_and_an_inactive_app_stop_deposits() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    env.set_paused(true);
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    assert_error(submit(&mut env, &d, &Assertion::by(&user.passkey)), SwishError::Paused);
    env.set_paused(false);

    let off = env.ix(
        swish_deposit::accounts::SetAppActive {
            admin: env.admin.pubkey(),
            config: pda(&[CONFIG_SEED]),
            app: pda(&[APP_SEED, &APP_ID]),
        },
        swish_deposit::instruction::SetAppActive { active: false },
    );
    env.send_as_admin(&[off]).unwrap();
    assert_error(submit(&mut env, &d, &Assertion::by(&user.passkey)), SwishError::AppInactive);

    // Another app is untouched by that switch.
    env.register_app(OTHER_APP_ID);
    let mut other = deposit(&mut env, &user, 0, units(5), in_app);
    other.app_id = OTHER_APP_ID;
    submit(&mut env, &other, &Assertion::by(&user.passkey)).unwrap();
}

#[test]
fn only_the_upgrade_authority_can_initialize_and_only_the_admin_can_register() {
    let mut svm = new_svm();
    svm.add_program(swish_deposit::ID, OURS).unwrap();
    let real = Keypair::new();
    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    set_upgrade_authority(&mut svm, &real.pubkey());
    let ix = Instruction::new_with_bytes(
        swish_deposit::ID,
        &swish_deposit::instruction::Initialize {
            args: swish_deposit::InitializeArgs {
                admin: attacker.pubkey(),
                cluster_tag: [0; 32],
                rp_id_hash: [0; 32],
            },
        }
        .data(),
        swish_deposit::accounts::Initialize {
            authority: attacker.pubkey(),
            config: pda(&[CONFIG_SEED]),
            program: swish_deposit::ID,
            program_data: program_data_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let msg = Message::new_with_blockhash(&[ix], Some(&attacker.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&attacker]).unwrap();
    let err = svm.send_transaction(tx).unwrap_err();
    assert!(format!("{:?}", err.err).contains(&format!("Custom({})", custom(SwishError::NotUpgradeAuthority))));

    let mut env = mainnet();
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let register = env.ix(
        swish_deposit::accounts::RegisterApp {
            admin: stranger.pubkey(),
            config: pda(&[CONFIG_SEED]),
            app: pda(&[APP_SEED, b"stranger-app-001"]),
            system_program: system_program::ID,
        },
        swish_deposit::instruction::RegisterApp { app_id: *b"stranger-app-001" },
    );
    assert_error(env.send(&[register], &[&stranger]), SwishError::NotAdmin);
}

// ---- linking wallets ----

#[test]
fn nobody_but_the_wallet_can_link_it() {
    let mut env = mainnet();
    let victim = Keypair::new();
    let mut ix = env.link_ix(&victim.pubkey(), &new_passkey());
    // Try to submit without the victim's signature.
    ix.accounts[0].is_signer = false;
    assert!(env.send_sponsored(&[ix], &[]).is_err());
    assert!(!env.exists(&linked_wallet_address(&victim.pubkey())));
}

#[test]
fn a_wallet_belongs_to_one_swish_id() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let wallet = user.wallets[0].kp.insecure_clone();
    let link_again = env.link_ix(&wallet.pubkey(), &new_passkey());
    assert!(env.send_sponsored(&[link_again], &[&wallet]).is_err());
}

#[test]
fn unlinking_stops_deposits_from_that_wallet_and_returns_the_rent() {
    let mut env = mainnet();
    let mut user = env.new_user(units(100), units(50), PullKind::Fixed);
    env.add_wallet(&mut user, units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let linked = linked_wallet_address(&user.wallets[0].kp.pubkey());
    let rent = env.lamports(&linked);
    let sponsor_before = env.lamports(&env.sponsor.pubkey());

    let unlink = env.unlink_ix(&user, &user.wallets[0]);
    let wallet = user.wallets[0].kp.insecure_clone();
    env.send_sponsored(&[unlink], &[&wallet]).unwrap();
    assert!(!env.exists(&linked));
    assert_eq!(env.lamports(&env.sponsor.pubkey()), sponsor_before + rent - TWO_SIGNATURE_FEE);

    let from_unlinked = deposit(&mut env, &user, 0, units(5), in_app);
    assert!(submit(&mut env, &from_unlinked, &Assertion::by(&user.passkey)).is_err());
    let from_linked = deposit(&mut env, &user, 1, units(5), in_app);
    submit(&mut env, &from_linked, &Assertion::by(&user.passkey)).unwrap();
}

#[test]
fn a_swish_id_closes_only_when_it_has_no_wallets() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let close = env.ix(
        swish_deposit::accounts::CloseSwishId { swish_id: user.swish_id, rent_payer: env.sponsor.pubkey() },
        swish_deposit::instruction::CloseSwishId {},
    );
    assert_error(env.send_sponsored(std::slice::from_ref(&close), &[]), SwishError::SwishIdHasWallets);

    let unlink = env.unlink_ix(&user, &user.wallets[0]);
    let wallet = user.wallets[0].kp.insecure_clone();
    env.send_sponsored(&[unlink], &[&wallet]).unwrap();
    env.send_sponsored(&[close], &[]).unwrap();
    assert!(!env.exists(&user.swish_id));
}

#[test]
fn a_new_passkey_means_relinking_and_the_old_one_stops_working() {
    let mut env = mainnet();
    let mut user = env.new_user(units(100), units(50), PullKind::Fixed);
    let old_passkey = user.passkey.clone();
    let new_key = new_passkey();

    // The wallet moves itself to the new Swish ID in one transaction.
    let unlink = env.unlink_ix(&user, &user.wallets[0]);
    let relink = env.link_ix(&user.wallets[0].kp.pubkey(), &new_key);
    let wallet = user.wallets[0].kp.insecure_clone();
    env.send_sponsored(&[unlink, relink], &[&wallet]).unwrap();

    let in_app = env.app_account();
    let stale = deposit(&mut env, &user, 0, units(5), in_app);
    assert_error(submit(&mut env, &stale, &Assertion::by(&old_passkey)), SwishError::WalletNotLinked);

    user.passkey = new_key;
    user.swish_id = swish_id_address(&user.passkey);
    let fresh = deposit(&mut env, &user, 0, units(5), in_app);
    submit(&mut env, &fresh, &Assertion::by(&user.passkey)).unwrap();
}

// ---- receipts ----

#[test]
fn refreshed_approvals_cannot_replay_a_deposit_after_its_first_deadline() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    let mut later = d.clone();
    later.expires_at += 60;
    let later_signature = sign(&env, &later, &Assertion::by(&user.passkey));
    submit_signed(&mut env, &d, &s).unwrap();

    let receipt = receipt_address(&d.deposit_id);
    let close = env.ix(
        swish_deposit::accounts::CloseReceipt { config: pda(&[CONFIG_SEED]), receipt, rent_payer: env.sponsor.pubkey() },
        swish_deposit::instruction::CloseReceipt {},
    );
    assert_error(env.send_sponsored(std::slice::from_ref(&close), &[]), SwishError::ReceiptPermanent);

    env.warp(61);
    assert_error(env.send_sponsored(&[close], &[]), SwishError::ReceiptPermanent);
    assert!(env.exists(&receipt));
    // The later signature is still valid but its deposit ID is already spent.
    assert!(submit_signed(&mut env, &later, &later_signature).is_err());
    assert!(submit_signed(&mut env, &d, &s).is_err());
    assert_eq!(env.balance(&in_app), units(5));
}

/// A fixed challenge, shared with the API's tests (services/api/test/chain.test.ts):
/// the server and the program must hash exactly the same bytes.
#[test]
fn the_challenge_matches_the_apis() {
    let program_id = Pubkey::from_str_const("D2JKE48xP76LQkr1fn41LM8nxG74uKohAXy5SEoPaL3p");
    let mint = Pubkey::new_from_array([3u8; 32]);
    let destination = Pubkey::new_from_array([4u8; 32]);
    let hash = PullChallenge {
        cluster_tag: &[1u8; 32],
        program_id: &program_id,
        deposit_id: &[5u8; 16],
        app_id: &[6u8; 16],
        mint: &mint,
        destination: &destination,
        amount: 12_500_000,
        expires_at: 1_790_000_090,
    }
    .hash();
    let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "76f08a1b0bb339ed8201b153cd2572be73d9fc518e8024b8a180e53961b4420f", "update the API test too if this changes");
}

#[test]
fn the_payment_commitment_matches_the_api_and_ignores_approval_deadlines() {
    let program_id = Pubkey::from_str_const("D2JKE48xP76LQkr1fn41LM8nxG74uKohAXy5SEoPaL3p");
    let mint = Pubkey::new_from_array([3u8; 32]);
    let destination = Pubkey::new_from_array([4u8; 32]);
    let mut payment = PullChallenge {
        cluster_tag: &[1u8; 32], program_id: &program_id,
        deposit_id: &[5u8; 16], app_id: &[6u8; 16], mint: &mint,
        destination: &destination, amount: 12_500_000, expires_at: 1_790_000_090,
    };
    let commitment = payment.payment_commitment();
    let hex: String = commitment.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "dcfaf7c4fb9620b1091ff3895428c902dac310426c2a9f3bd215b928cae732ef");
    payment.expires_at += 60;
    assert_eq!(payment.payment_commitment(), commitment);
}

// ---- retiring ----

#[test]
fn only_the_upgrade_authority_can_retire_not_the_admin_or_anyone_else() {
    let mut env = mainnet();
    let upgrade_authority = env.admin.insecure_clone();
    // Hand the admin role to another key, as production will.
    let admin = Keypair::new();
    env.svm.airdrop(&admin.pubkey(), 1_000_000_000).unwrap();
    let propose = env.ix(
        swish_deposit::accounts::AdminOnly { admin: upgrade_authority.pubkey(), config: pda(&[CONFIG_SEED]) },
        swish_deposit::instruction::ProposeAdmin { new_admin: admin.pubkey() },
    );
    env.send_as_admin(&[propose]).unwrap();
    let accept = env.ix(
        swish_deposit::accounts::AcceptAdmin { pending_admin: admin.pubkey(), config: pda(&[CONFIG_SEED]) },
        swish_deposit::instruction::AcceptAdmin {},
    );
    env.send(&[accept], &[&admin]).unwrap();

    let by_admin = env.retire_ix(&admin.pubkey());
    assert_error(env.send(&[by_admin], &[&admin]), SwishError::NotUpgradeAuthority);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let by_stranger = env.retire_ix(&stranger.pubkey());
    assert_error(env.send(&[by_stranger], &[&stranger]), SwishError::NotUpgradeAuthority);

    // Deposits still work after both attempts.
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    submit(&mut env, &d, &Assertion::by(&user.passkey)).unwrap();

    let retire = env.retire_ix(&upgrade_authority.pubkey());
    env.send(&[retire], &[&upgrade_authority]).unwrap();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    assert_error(submit(&mut env, &d, &Assertion::by(&user.passkey)), SwishError::Retired);
}

#[test]
fn retiring_is_final_and_stops_every_deposit() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    // Signed before retiring, still inside its deadline.
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    env.set_paused(true);
    let retire = env.retire_ix(&env.admin.pubkey());
    env.send_as_admin(&[retire]).unwrap();

    assert_error(submit_signed(&mut env, &d, &s), SwishError::Retired);
    for paused in [false, true] {
        let switch = env.ix(
            swish_deposit::accounts::AdminOnly { admin: env.admin.pubkey(), config: pda(&[CONFIG_SEED]) },
            swish_deposit::instruction::SetPaused { paused },
        );
        assert_error(env.send_as_admin(&[switch]), SwishError::Retired);
    }
    assert_error(submit_signed(&mut env, &d, &s), SwishError::Retired);
    let fresh = deposit(&mut env, &user, 0, units(5), in_app);
    assert_error(submit(&mut env, &fresh, &Assertion::by(&user.passkey)), SwishError::Retired);
    assert_eq!(env.balance(&in_app), 0);
}

#[test]
fn receipts_close_only_once_retired_and_only_back_to_their_rent_payer() {
    let mut env = mainnet();
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let in_app = env.app_account();
    let d = deposit(&mut env, &user, 0, units(5), in_app);
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    submit_signed(&mut env, &d, &s).unwrap();
    let receipt = receipt_address(&d.deposit_id);
    let sponsor = env.sponsor.pubkey();

    // Live, then paused: the receipt stays.
    let close = env.close_receipt_ix(&d.deposit_id, &sponsor);
    assert_error(env.send_sponsored(std::slice::from_ref(&close), &[]), SwishError::ReceiptPermanent);
    env.set_paused(true);
    assert_error(env.send_sponsored(std::slice::from_ref(&close), &[]), SwishError::ReceiptPermanent);

    let retire = env.retire_ix(&env.admin.pubkey());
    env.send_as_admin(&[retire]).unwrap();

    // Nobody can take the rent for themselves.
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let steal = env.close_receipt_ix(&d.deposit_id, &attacker.pubkey());
    let err = env.send(&[steal], &[&attacker]).expect_err("rent went to the wrong account");
    assert!(err.contains("Custom(2001)"), "expected ConstraintHasOne, got: {err}");
    assert!(env.exists(&receipt));

    // Anyone may close it; the rent goes back to the sponsor that paid it.
    let rent = env.lamports(&receipt);
    let before = env.lamports(&sponsor);
    env.send(&[close], &[&attacker]).unwrap();
    assert!(!env.exists(&receipt));
    assert_eq!(env.lamports(&sponsor), before + rent);

    // With its receipt gone, the deposit still cannot be paid again.
    assert_error(submit_signed(&mut env, &d, &s), SwishError::Retired);
    assert_eq!(env.balance(&in_app), units(5));
}

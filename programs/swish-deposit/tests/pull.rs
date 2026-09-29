//! End-to-end tests against the REAL Solana Foundation Subscriptions program
//! (both the mainnet and the devnet build, dumped into tests/fixtures), the
//! real SPL Token program and the real secp256r1 precompile.
//!
//! Build the program first: `cargo-build-sbf` (see README), then `cargo test`.

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
    error::SwishError, state::PullKind, webauthn::{base64url_32, PullChallenge}, PullArgs,
    APP_SEED, CONFIG_SEED, DESTINATION_SEED, PASSKEY_SEED, PULLER_SEED,
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
const ATA_PROGRAM: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SECP256R1_PROGRAM: Pubkey = anchor_lang::pubkey!("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");

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

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    sponsor: Keypair,
    mint: Pubkey,
    app: Pubkey,
    app_ata: Pubkey,
    cluster_tag: [u8; 32],
}

struct User {
    wallet: Keypair,
    ata: Pubkey,
    passkey: SigningKey,
    authority: Pubkey,
    delegation: Pubkey,
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

        let mut env = Env {
            svm,
            admin,
            sponsor,
            mint,
            app: pda(&[APP_SEED, &APP_ID]),
            app_ata: Pubkey::default(),
            cluster_tag: [7u8; 32],
        };

        let admin_key = env.admin.pubkey();
        let initialize = Instruction::new_with_bytes(
            swish_deposit::ID,
            &swish_deposit::instruction::Initialize {
                args: swish_deposit::InitializeArgs {
                    admin: admin_key,
                    cluster_tag: env.cluster_tag,
                    rp_id_hash: Sha256::digest(RP_ID).into(),
                },
            }
            .data(),
            swish_deposit::accounts::Initialize {
                authority: admin_key,
                config: pda(&[CONFIG_SEED]),
                program: swish_deposit::ID,
                program_data: program_data_address(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        env.send(&[initialize], &[&env.admin.insecure_clone()]).unwrap();

        env.app_ata = env.register_app(APP_ID);
        env
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| {
            format!("{:?}\n{}", e.err, e.meta.logs.join("\n"))
        })
    }

    fn admin_ix<A: ToAccountMetas, D: InstructionData>(&self, accounts: A, data: D) -> Instruction {
        Instruction::new_with_bytes(swish_deposit::ID, &data.data(), accounts.to_account_metas(None))
    }

    /// Registers an app and gives it a token account for the test mint.
    fn register_app(&mut self, app_id: [u8; 16]) -> Pubkey {
        let app = pda(&[APP_SEED, &app_id]);
        let owner = Pubkey::new_unique();
        let app_ata = ata(&owner, &self.mint);
        set_token_account(&mut self.svm, app_ata, self.mint, owner, 0);
        let admin = self.admin.pubkey();
        let register = self.admin_ix(
            swish_deposit::accounts::RegisterApp {
                admin,
                config: pda(&[CONFIG_SEED]),
                app,
                system_program: system_program::ID,
            },
            swish_deposit::instruction::RegisterApp { app_id },
        );
        let destination = self.admin_ix(
            swish_deposit::accounts::SetDestination {
                admin,
                config: pda(&[CONFIG_SEED]),
                app,
                mint: self.mint,
                token_account: app_ata,
                destination: pda(&[DESTINATION_SEED, app.as_ref(), self.mint.as_ref()]),
                token_program: spl_token::ID,
                system_program: system_program::ID,
            },
            swish_deposit::instruction::SetDestination {},
        );
        let admin_kp = self.admin.insecure_clone();
        self.send(&[register, destination], &[&admin_kp]).unwrap();
        app_ata
    }

    /// A user with `balance` tokens who has done the one-time setup: the
    /// Foundation authority, an allowance naming our puller, and a passkey.
    fn new_user(&mut self, balance: u64, allowance: u64, kind: PullKind) -> User {
        let wallet = Keypair::new();
        let user_ata = ata(&wallet.pubkey(), &self.mint);
        set_token_account(&mut self.svm, user_ata, self.mint, wallet.pubkey(), balance);
        let passkey = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let (authority, _) = SubscriptionAuthority::find_pda(&wallet.pubkey(), &self.mint);
        let puller = pda(&[PULLER_SEED]);
        let (delegation, _) = FixedDelegation::find_pda(&authority, &wallet.pubkey(), &puller, 0);

        let init = InitSubscriptionAuthority {
            owner: wallet.pubkey(),
            subscription_authority: authority,
            token_mint: self.mint,
            user_ata,
            system_program: system_program::ID,
            token_program: spl_token::ID,
            payer: Some(self.sponsor.pubkey()),
        }
        .instruction();
        let sponsor = self.sponsor.insecure_clone();
        self.send(&[init], &[&sponsor, &wallet]).unwrap();
        let init_id = {
            let acc = self.svm.get_account(&authority).unwrap();
            SubscriptionAuthority::from_bytes(&acc.data).unwrap().init_id
        };

        let create = match kind {
            PullKind::Fixed => CreateFixedDelegation {
                delegator: wallet.pubkey(),
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
                delegator: wallet.pubkey(),
                subscription_authority: authority,
                delegation_account: RecurringDelegation::find_pda(&authority, &wallet.pubkey(), &puller, 0).0,
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
        let register = self.register_passkey_ix(&wallet.pubkey(), &passkey);
        self.send(&[create, register], &[&sponsor, &wallet]).unwrap();

        User { wallet, ata: user_ata, passkey, authority, delegation }
    }

    fn register_passkey_ix(&self, wallet: &Pubkey, passkey: &SigningKey) -> Instruction {
        self.admin_ix(
            swish_deposit::accounts::RegisterPasskey {
                wallet: *wallet,
                payer: self.sponsor.pubkey(),
                user_passkey: pda(&[PASSKEY_SEED, wallet.as_ref()]),
                system_program: system_program::ID,
            },
            swish_deposit::instruction::RegisterPasskey { passkey: compressed(passkey) },
        )
    }

    fn next_nonce(&self, user: &User) -> u64 {
        let acc = self.svm.get_account(&pda(&[PASSKEY_SEED, user.wallet.pubkey().as_ref()])).unwrap();
        swish_deposit::state::UserPasskey::try_deserialize(&mut acc.data.as_slice()).unwrap().next_nonce
    }

    fn balance(&self, token_account: &Pubkey) -> u64 {
        let acc = self.svm.get_account(token_account).unwrap();
        spl_token::state::Account::unpack(&acc.data).unwrap().amount
    }

    fn set_paused(&mut self, paused: bool) {
        let ix = self.admin_ix(
            swish_deposit::accounts::AdminOnly { admin: self.admin.pubkey(), config: pda(&[CONFIG_SEED]) },
            swish_deposit::instruction::SetPaused { paused },
        );
        let admin = self.admin.insecure_clone();
        self.send(&[ix], &[&admin]).unwrap();
    }

    fn warp(&mut self, seconds: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += seconds;
        clock.slot += 1;
        self.svm.set_sysvar(&clock);
    }
}

/// Everything a deposit is made of. Tests build one, let the user's passkey
/// sign it, then tamper with either side.
#[derive(Clone)]
struct Deposit {
    kind: PullKind,
    amount: u64,
    nonce: u64,
    expires_at: i64,
    delegation: Pubkey,
    app_id: [u8; 16],
    receiver: Pubkey,
    wallet: Pubkey,
    source: Pubkey,
    authority: Pubkey,
}

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

fn deposit(env: &Env, user: &User, amount: u64) -> Deposit {
    Deposit {
        kind: PullKind::Fixed,
        amount,
        nonce: env.next_nonce(user),
        expires_at: NOW + 60,
        delegation: user.delegation,
        app_id: APP_ID,
        receiver: env.app_ata,
        wallet: user.wallet.pubkey(),
        source: user.ata,
        authority: user.authority,
    }
}

fn challenge(env: &Env, d: &Deposit) -> [u8; 32] {
    PullChallenge {
        cluster_tag: &env.cluster_tag,
        program_id: &swish_deposit::ID,
        wallet: &d.wallet,
        delegation: &d.delegation,
        app_id: &d.app_id,
        mint: &env.mint,
        destination: &d.receiver,
        kind: d.kind.as_u8(),
        amount: d.amount,
        nonce: d.nonce,
        expires_at: d.expires_at,
    }
    .hash()
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
    let app = pda(&[APP_SEED, &d.app_id]);
    Instruction::new_with_bytes(
        swish_deposit::ID,
        &swish_deposit::instruction::Pull {
            args: PullArgs {
                kind: d.kind,
                amount: d.amount,
                nonce: d.nonce,
                expires_at: d.expires_at,
                client_data_json,
            },
        }
        .data(),
        swish_deposit::accounts::Pull {
            config: pda(&[CONFIG_SEED]),
            app,
            destination: pda(&[DESTINATION_SEED, app.as_ref(), env.mint.as_ref()]),
            user_passkey: pda(&[PASSKEY_SEED, d.wallet.as_ref()]),
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
        }
        .to_account_metas(None),
    )
}

/// The normal path: sign exactly `d`, submit exactly `d`, sponsor pays.
fn submit(env: &mut Env, d: &Deposit, a: &Assertion) -> Result<(), String> {
    let s = sign(env, d, a);
    submit_signed(env, d, &s)
}

fn submit_signed(env: &mut Env, d: &Deposit, s: &Signed) -> Result<(), String> {
    let ixs = [precompile_ix(s, u16::MAX), pull_ix(env, d, s.client_data_json.clone())];
    let sponsor = env.sponsor.insecure_clone();
    env.send(&ixs, &[&sponsor])
}

fn assert_error(res: Result<(), String>, e: SwishError) {
    let code = custom(e);
    let err = res.expect_err("expected the pull to fail");
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

// ---- the tests ----

#[test]
fn a_signed_deposit_moves_money_and_spends_the_nonce() {
    each_build(|build, foundation| {
        let mut env = Env::new(foundation);
        let user = env.new_user(units(100), units(50), PullKind::Fixed);
        let d = deposit(&env, &user, units(20));
        submit(&mut env, &d, &Assertion::by(&user.passkey)).unwrap_or_else(|e| panic!("{build}: {e}"));

        assert_eq!(env.balance(&user.ata), units(80), "{build}");
        assert_eq!(env.balance(&env.app_ata), units(20), "{build}");
        assert_eq!(env.next_nonce(&user), d.nonce + 1, "{build}");
        let delegation = env.svm.get_account(&user.delegation).unwrap();
        assert_eq!(FixedDelegation::from_bytes(&delegation.data).unwrap().amount, units(30), "{build}");
    });
}

#[test]
fn a_recurring_allowance_can_be_pulled_too() {
    each_build(|build, foundation| {
        let mut env = Env::new(foundation);
        let user = env.new_user(units(100), units(10), PullKind::Recurring);
        let puller = pda(&[PULLER_SEED]);
        let mut d = deposit(&env, &user, units(10));
        d.kind = PullKind::Recurring;
        d.delegation = RecurringDelegation::find_pda(&user.authority, &user.wallet.pubkey(), &puller, 0).0;
        submit(&mut env, &d, &Assertion::by(&user.passkey)).unwrap_or_else(|e| panic!("{build}: {e}"));
        assert_eq!(env.balance(&env.app_ata), units(10), "{build}");

        // The period's cap is spent: one more unit in the same period fails.
        let mut again = deposit(&env, &user, 1);
        again.kind = PullKind::Recurring;
        again.delegation = d.delegation;
        assert!(submit(&mut env, &again, &Assertion::by(&user.passkey)).is_err(), "{build}");
    });
}

#[test]
fn the_same_signed_deposit_cannot_be_replayed() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    submit_signed(&mut env, &d, &s).unwrap();
    assert_error(submit_signed(&mut env, &d, &s), SwishError::WrongNonce);
    assert_eq!(env.balance(&env.app_ata), units(5));
}

#[test]
fn nothing_the_passkey_signed_can_be_changed() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let other_app_ata = env.register_app(*b"other-app-000002");
    let signed_for = deposit(&env, &user, units(5));
    let s = sign(&env, &signed_for, &Assertion::by(&user.passkey));

    let mut more = signed_for.clone();
    more.amount = units(50);
    assert_error(submit_signed(&mut env, &more, &s), SwishError::ChallengeMismatch);

    let mut elsewhere = signed_for.clone();
    elsewhere.app_id = *b"other-app-000002";
    elsewhere.receiver = other_app_ata;
    assert_error(submit_signed(&mut env, &elsewhere, &s), SwishError::ChallengeMismatch);

    let mut later = signed_for.clone();
    later.expires_at += 30;
    assert_error(submit_signed(&mut env, &later, &s), SwishError::ChallengeMismatch);

    assert_eq!(env.balance(&user.ata), units(100));
}

#[test]
fn only_the_registered_passkey_works() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let stranger = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    assert_error(submit(&mut env, &d, &Assertion::by(&stranger)), SwishError::WrongPasskey);
}

#[test]
fn a_pull_without_a_signature_check_before_it_fails() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    let sponsor = env.sponsor.insecure_clone();
    assert_error(
        env.send(&[pull_ix(&env, &d, s.client_data_json.clone())], &[&sponsor]),
        SwishError::MissingPasskeySignature,
    );
}

#[test]
fn a_signature_check_must_carry_its_own_data() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    // Offsets pointing at instruction 0 (itself, by index rather than by
    // u16::MAX): the precompile accepts it, we must not.
    let ixs = [precompile_ix(&s, 0), pull_ix(&env, &d, s.client_data_json.clone())];
    let sponsor = env.sponsor.insecure_clone();
    assert_error(env.send(&ixs, &[&sponsor]), SwishError::MalformedPasskeySignature);
}

#[test]
fn one_signature_check_cannot_cover_two_pulls() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    let mut second = d.clone();
    second.nonce += 1;
    let ixs = [
        precompile_ix(&s, u16::MAX),
        pull_ix(&env, &d, s.client_data_json.clone()),
        pull_ix(&env, &second, s.client_data_json.clone()),
    ];
    let sponsor = env.sponsor.insecure_clone();
    assert_error(env.send(&ixs, &[&sponsor]), SwishError::MissingPasskeySignature);
    assert_eq!(env.balance(&user.ata), units(100));
}

#[test]
fn face_id_must_have_verified_the_user() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let mut a = Assertion::by(&user.passkey);
    a.flags = 0x01; // present, not verified
    assert_error(submit(&mut env, &d, &a), SwishError::UserNotVerified);
}

#[test]
fn a_passkey_signature_for_another_site_is_refused() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let mut a = Assertion::by(&user.passkey);
    a.rp_id = "evil.example".into();
    assert_error(submit(&mut env, &d, &a), SwishError::WrongRelyingParty);
}

#[test]
fn a_registration_signature_is_not_a_deposit_approval() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let mut a = Assertion::by(&user.passkey);
    a.client_type = "webauthn.create";
    assert_error(submit(&mut env, &d, &a), SwishError::ChallengeMismatch);
}

#[test]
fn client_data_must_match_what_was_signed() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let mut s = sign(&env, &d, &Assertion::by(&user.passkey));
    s.client_data_json.push(b' ');
    assert_error(submit_signed(&mut env, &d, &s), SwishError::ClientDataMismatch);
}

#[test]
fn a_high_s_signature_is_refused_by_the_runtime() {
    // Browsers can return either form; the client must normalise to low-S.
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let mut a = Assertion::by(&user.passkey);
    a.high_s = true;
    assert!(submit(&mut env, &d, &a).is_err());
}

#[test]
fn signatures_expire() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let s = sign(&env, &d, &Assertion::by(&user.passkey));
    env.warp(61);
    assert_error(submit_signed(&mut env, &d, &s), SwishError::SignatureExpired);

    let mut far = deposit(&env, &user, units(5));
    far.expires_at = NOW + 61 + 121;
    assert_error(submit(&mut env, &far, &Assertion::by(&user.passkey)), SwishError::DeadlineTooFar);
}

#[test]
fn the_allowance_caps_every_pull() {
    each_build(|build, foundation| {
        let mut env = Env::new(foundation);
        let user = env.new_user(units(100), units(50), PullKind::Fixed);
        let d = deposit(&env, &user, units(51));
        assert!(submit(&mut env, &d, &Assertion::by(&user.passkey)).is_err(), "{build}");
        assert_eq!(env.balance(&user.ata), units(100), "{build}");
    });
}

#[test]
fn someone_elses_allowance_cannot_be_used() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let alice = env.new_user(units(100), units(50), PullKind::Fixed);
    let bob = env.new_user(units(100), units(50), PullKind::Fixed);
    // Alice's passkey and token account, Bob's allowance.
    let mut d = deposit(&env, &alice, units(5));
    d.delegation = bob.delegation;
    d.authority = bob.authority;
    assert_error(submit(&mut env, &d, &Assertion::by(&alice.passkey)), SwishError::WrongDelegation);

    // Bob's token account too: the account checks refuse before anything moves.
    d.source = bob.ata;
    assert!(submit(&mut env, &d, &Assertion::by(&alice.passkey)).is_err());
    assert_eq!(env.balance(&bob.ata), units(100));
}

#[test]
fn pause_and_inactive_apps_stop_deposits() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    env.set_paused(true);
    let d = deposit(&env, &user, units(5));
    assert_error(submit(&mut env, &d, &Assertion::by(&user.passkey)), SwishError::Paused);
    env.set_paused(false);

    let admin = env.admin.pubkey();
    let off = env.admin_ix(
        swish_deposit::accounts::SetAppActive { admin, config: pda(&[CONFIG_SEED]), app: env.app },
        swish_deposit::instruction::SetAppActive { active: false },
    );
    let admin_kp = env.admin.insecure_clone();
    env.send(&[off], &[&admin_kp]).unwrap();
    assert_error(submit(&mut env, &d, &Assertion::by(&user.passkey)), SwishError::AppInactive);
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

    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let register = env.admin_ix(
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

#[test]
fn removing_the_passkey_stops_deposits_and_returns_the_rent() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let d = deposit(&env, &user, units(5));
    let passkey_account = pda(&[PASSKEY_SEED, user.wallet.pubkey().as_ref()]);
    let rent = env.svm.get_account(&passkey_account).unwrap().lamports;
    let sponsor_before = env.svm.get_account(&env.sponsor.pubkey()).unwrap().lamports;

    let remove = env.admin_ix(
        swish_deposit::accounts::RemovePasskey {
            wallet: user.wallet.pubkey(),
            user_passkey: passkey_account,
            rent_payer: env.sponsor.pubkey(),
        },
        swish_deposit::instruction::RemovePasskey {},
    );
    let wallet = user.wallet.insecure_clone();
    let sponsor = env.sponsor.insecure_clone();
    env.send(&[remove], &[&sponsor, &wallet]).unwrap();
    assert!(env.svm.get_account(&passkey_account).is_none_or(|a| a.lamports == 0));
    // The sponsor paid the fee (two signatures × 5000) and got the rent back.
    assert_eq!(env.svm.get_account(&env.sponsor.pubkey()).unwrap().lamports, sponsor_before + rent - 10_000);
    assert!(submit(&mut env, &d, &Assertion::by(&user.passkey)).is_err());
}

#[test]
fn rotating_the_passkey_retires_the_old_one() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let user = env.new_user(units(100), units(50), PullKind::Fixed);
    let new_key = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let rotate = env.admin_ix(
        swish_deposit::accounts::RotatePasskey {
            wallet: user.wallet.pubkey(),
            user_passkey: pda(&[PASSKEY_SEED, user.wallet.pubkey().as_ref()]),
        },
        swish_deposit::instruction::RotatePasskey { passkey: compressed(&new_key) },
    );
    let wallet = user.wallet.insecure_clone();
    let sponsor = env.sponsor.insecure_clone();
    env.send(&[rotate], &[&sponsor, &wallet]).unwrap();

    let d = deposit(&env, &user, units(5));
    assert_error(submit(&mut env, &d, &Assertion::by(&user.passkey)), SwishError::WrongPasskey);
    submit(&mut env, &d, &Assertion::by(&new_key)).unwrap();
}

#[test]
fn nobody_but_the_wallet_can_register_its_passkey() {
    let mut env = Env::new(FOUNDATION_BUILDS[0].1);
    let victim = Keypair::new();
    let attacker_key = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let mut ix = env.register_passkey_ix(&victim.pubkey(), &attacker_key);
    // Try to submit without the victim's signature.
    ix.accounts[0].is_signer = false;
    let sponsor = env.sponsor.insecure_clone();
    assert!(env.send(&[ix], &[&sponsor]).is_err());
}

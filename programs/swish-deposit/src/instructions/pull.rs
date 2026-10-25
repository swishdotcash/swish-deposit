use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::get_stack_height;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;
use subscriptions::{
    instructions::{
        TransferFixedCpi, TransferFixedCpiAccounts, TransferFixedInstructionArgs,
        TransferRecurringCpi, TransferRecurringCpiAccounts, TransferRecurringInstructionArgs,
    },
    types::{AccountDiscriminator, TransferData},
    FixedDelegation, RecurringDelegation, SUBSCRIPTIONS_ID,
};

use crate::{
    constants::*,
    error::SwishError,
    events::Deposited,
    state::{App, Config, DepositReceipt, LinkedWallet, PullKind, SwishId},
    webauthn::{verify_passkey_approval, PasskeyApproval, PullChallenge},
};

/// Top-level instructions run at stack height 1.
const TOP_LEVEL: usize = 1;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PullArgs {
    /// One-time id from our server; signed by the passkey, usable once.
    pub deposit_id: [u8; 16],
    /// Which allowance of the wallet to use. Not signed: both are the user's.
    pub kind: PullKind,
    pub amount: u64,
    pub expires_at: i64,
    pub client_data_json: Vec<u8>,
}

#[derive(Accounts)]
#[instruction(args: PullArgs)]
pub struct Pull<'info> {
    /// Pays the receipt's rent (Swish, in production).
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.status != RETIRED @ SwishError::Retired,
        constraint = config.status == LIVE @ SwishError::Paused
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [APP_SEED, app.app_id.as_ref()],
        bump = app.bump,
        constraint = app.active @ SwishError::AppInactive
    )]
    pub app: Box<Account<'info, App>>,
    /// The passkey that signed must be this Swish ID's (checked in the handler).
    pub swish_id: Box<Account<'info, SwishId>>,
    #[account(
        seeds = [WALLET_SEED, linked_wallet.wallet.as_ref()],
        bump = linked_wallet.bump,
        constraint = linked_wallet.swish_id == swish_id.key() @ SwishError::WalletNotLinked
    )]
    pub linked_wallet: Box<Account<'info, LinkedWallet>>,
    /// Fails if this deposit id was used before.
    #[account(
        init,
        payer = payer,
        space = 8 + DepositReceipt::INIT_SPACE,
        seeds = [RECEIPT_SEED, args.deposit_id.as_ref()],
        bump
    )]
    pub receipt: Box<Account<'info, DepositReceipt>>,
    /// CHECK: our PDA; the delegatee of every allowance, signs the CPI.
    #[account(seeds = [PULLER_SEED], bump = config.puller_bump)]
    pub puller: UncheckedAccount<'info>,
    /// CHECK: owner checked here; contents checked in the handler.
    #[account(mut, owner = SUBSCRIPTIONS_ID)]
    pub delegation: UncheckedAccount<'info>,
    /// CHECK: must be the delegation's authority (handler); the Foundation
    /// program checks it too.
    pub subscription_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = linked_wallet.wallet,
        token::token_program = token_program
    )]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Any token account of the mint: the app's server chooses it (usually
    /// the user's own account in the app) and the passkey signs it.
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub receiver: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: the Foundation program checks its own event authority.
    pub subscriptions_event_authority: UncheckedAccount<'info>,
    /// CHECK: address pinned.
    #[account(address = SUBSCRIPTIONS_ID)]
    pub subscriptions_program: UncheckedAccount<'info>,
    /// CHECK: address pinned.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_pull<'info>(ctx: Context<'info, Pull<'info>>, args: PullArgs) -> Result<()> {
    // The passkey check reads the instruction before this one; that only
    // means something when this is a transaction-level instruction.
    require!(get_stack_height() == TOP_LEVEL, SwishError::CpiNotAllowed);
    require!(args.amount > 0, SwishError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    require!(now <= args.expires_at, SwishError::SignatureExpired);
    require!(
        args.expires_at <= now.saturating_add(MAX_SIGNATURE_LIFETIME_SECS),
        SwishError::DeadlineTooFar
    );

    let accounts = &ctx.accounts;
    let wallet = accounts.linked_wallet.wallet;
    check_delegation(accounts, args.kind, &wallet)?;

    let mint = accounts.mint.key();
    let destination = accounts.receiver.key();
    let approved_payment = PullChallenge {
        cluster_tag: &accounts.config.cluster_tag,
        program_id: ctx.program_id,
        deposit_id: &args.deposit_id,
        app_id: &accounts.app.app_id,
        mint: &mint,
        destination: &destination,
        amount: args.amount,
        expires_at: args.expires_at,
    };
    let challenge = approved_payment.hash();
    let commitment = approved_payment.payment_commitment();
    verify_passkey_approval(
        &accounts.instructions.to_account_info(),
        PasskeyApproval {
            passkey: &accounts.swish_id.passkey,
            rp_id_hash: &accounts.config.rp_id_hash,
            challenge: &challenge,
            client_data_json: &args.client_data_json,
        },
    )?;

    // The receipt was created by `init` above, so this id is now spent.
    let receipt = &mut ctx.accounts.receipt;
    receipt.expires_at = args.expires_at;
    receipt.rent_payer = ctx.accounts.payer.key();
    receipt.bump = ctx.bumps.receipt;
    receipt.commitment = commitment;
    receipt.wallet = wallet;
    receipt.swish_id = ctx.accounts.swish_id.key();

    let accounts = &ctx.accounts;
    let transfer_data = TransferData {
        amount: args.amount,
        delegator: wallet,
        mint: accounts.mint.key(),
    };
    let puller_seeds: &[&[u8]] = &[PULLER_SEED, &[accounts.config.puller_bump]];
    // Token-2022 transfer hooks need extra accounts; pass them on, never as signers.
    let remaining: Vec<(&AccountInfo<'info>, bool, bool)> = ctx
        .remaining_accounts
        .iter()
        .map(|a| (a, a.is_writable, false))
        .collect();

    let program = accounts.subscriptions_program.to_account_info();
    let delegation = accounts.delegation.to_account_info();
    let subscription_authority = accounts.subscription_authority.to_account_info();
    let source = accounts.source.to_account_info();
    let receiver = accounts.receiver.to_account_info();
    let mint = accounts.mint.to_account_info();
    let token_program = accounts.token_program.to_account_info();
    let puller = accounts.puller.to_account_info();
    let event_authority = accounts.subscriptions_event_authority.to_account_info();

    match args.kind {
        PullKind::Fixed => TransferFixedCpi::new(
            &program,
            TransferFixedCpiAccounts {
                delegation_pda: &delegation,
                subscription_authority: &subscription_authority,
                delegator_ata: &source,
                receiver_ata: &receiver,
                token_mint: &mint,
                token_program: &token_program,
                delegatee: &puller,
                event_authority: &event_authority,
                self_program: &program,
            },
            TransferFixedInstructionArgs { transfer_data },
        )
        .invoke_signed_with_remaining_accounts(&[puller_seeds], &remaining)?,
        PullKind::Recurring => TransferRecurringCpi::new(
            &program,
            TransferRecurringCpiAccounts {
                delegation_pda: &delegation,
                subscription_authority: &subscription_authority,
                delegator_ata: &source,
                receiver_ata: &receiver,
                token_mint: &mint,
                token_program: &token_program,
                delegatee: &puller,
                event_authority: &event_authority,
                self_program: &program,
            },
            TransferRecurringInstructionArgs { transfer_data },
        )
        .invoke_signed_with_remaining_accounts(&[puller_seeds], &remaining)?,
    }

    emit!(Deposited {
        deposit_id: args.deposit_id,
        swish_id: accounts.swish_id.key(),
        wallet,
        app_id: accounts.app.app_id,
        mint: accounts.mint.key(),
        destination: accounts.receiver.key(),
        delegation: accounts.delegation.key(),
        kind: args.kind,
        amount: args.amount,
    });
    Ok(())
}

/// The Foundation program checks all of this again on transfer. We check it
/// first so a pull can never touch an allowance that is not this wallet's,
/// not for this mint, or not naming our puller.
fn check_delegation(accounts: &Pull, kind: PullKind, wallet: &Pubkey) -> Result<()> {
    let data = accounts.delegation.try_borrow_data()?;
    let (header, authority, mint) = match kind {
        PullKind::Fixed => {
            let d = FixedDelegation::from_bytes(&data).map_err(|_| SwishError::WrongDelegation)?;
            require!(
                d.header.discriminator == AccountDiscriminator::FixedDelegation as u8,
                SwishError::WrongDelegation
            );
            (d.header, d.subscription_authority, d.mint)
        }
        PullKind::Recurring => {
            let d = RecurringDelegation::from_bytes(&data).map_err(|_| SwishError::WrongDelegation)?;
            require!(
                d.header.discriminator == AccountDiscriminator::RecurringDelegation as u8,
                SwishError::WrongDelegation
            );
            (d.header, d.subscription_authority, d.mint)
        }
    };
    require!(
        header.delegator == *wallet
            && header.delegatee == accounts.puller.key()
            && mint == accounts.mint.key()
            && authority == accounts.subscription_authority.key(),
        SwishError::WrongDelegation
    );
    Ok(())
}

/// Receipts are spent markers: a later approval may name the same deposit id
/// with a later deadline. Once retired, no pull can run, so anyone may close
/// them; the rent only ever goes back to whoever paid it.
#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.status == RETIRED @ SwishError::ReceiptPermanent
    )]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = rent_payer, close = rent_payer)]
    pub receipt: Account<'info, DepositReceipt>,
    /// CHECK: only receives lamports; must match `receipt.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn handle_close_receipt(_ctx: Context<CloseReceipt>) -> Result<()> {
    Ok(())
}

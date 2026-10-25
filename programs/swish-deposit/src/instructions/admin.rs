use anchor_lang::prelude::*;

use crate::{constants::*, error::SwishError, program::SwishDeposit, state::Config};

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeArgs {
    pub admin: Pubkey,
    pub cluster_tag: [u8; 32],
    pub rp_id_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, SwishDeposit>,
    // Stops anyone else from initialising first, right after a deploy.
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ SwishError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
    let (_, puller_bump) = Pubkey::find_program_address(&[PULLER_SEED], ctx.program_id);
    ctx.accounts.config.set_inner(Config {
        admin: args.admin,
        pending_admin: Pubkey::default(),
        cluster_tag: args.cluster_tag,
        rp_id_hash: args.rp_id_hash,
        status: LIVE,
        bump: ctx.bumps.config,
        puller_bump,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ SwishError::NotAdmin
    )]
    pub config: Account<'info, Config>,
}

pub fn handle_propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_admin = new_admin;
    Ok(())
}

pub fn handle_set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.status != RETIRED, SwishError::Retired);
    config.status = if paused { PAUSED } else { LIVE };
    Ok(())
}

/// The upgrade authority, not the admin: it can already replace the program,
/// so this adds no power to it, and a stolen admin key cannot end deposits.
#[derive(Accounts)]
pub struct Retire<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, SwishDeposit>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ SwishError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
}

/// Ends deposits for good: nothing in this program sets `status` back. Only
/// then can receipts be closed, since no pull can ever spend a deposit id again.
pub fn handle_retire(ctx: Context<Retire>) -> Result<()> {
    ctx.accounts.config.status = RETIRED;
    Ok(())
}

pub fn handle_set_rp_id_hash(ctx: Context<AdminOnly>, rp_id_hash: [u8; 32]) -> Result<()> {
    ctx.accounts.config.rp_id_hash = rp_id_hash;
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_admin == pending_admin.key()
            && pending_admin.key() != Pubkey::default() @ SwishError::NotPendingAdmin
    )]
    pub config: Account<'info, Config>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = config.pending_admin;
    config.pending_admin = Pubkey::default();
    Ok(())
}

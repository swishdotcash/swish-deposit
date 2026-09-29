use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*,
    error::SwishError,
    state::{App, AppDestination, Config},
};

#[derive(Accounts)]
#[instruction(app_id: [u8; 16])]
pub struct RegisterApp<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ SwishError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        space = 8 + App::INIT_SPACE,
        seeds = [APP_SEED, app_id.as_ref()],
        bump
    )]
    pub app: Account<'info, App>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_app(ctx: Context<RegisterApp>, app_id: [u8; 16]) -> Result<()> {
    ctx.accounts.app.set_inner(App {
        app_id,
        active: true,
        bump: ctx.bumps.app,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetAppActive<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ SwishError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [APP_SEED, app.app_id.as_ref()], bump = app.bump)]
    pub app: Account<'info, App>,
}

pub fn handle_set_app_active(ctx: Context<SetAppActive>, active: bool) -> Result<()> {
    ctx.accounts.app.active = active;
    Ok(())
}

/// Creates or replaces where an app receives one mint. A passkey signs the
/// destination token account, so a change here cannot redirect a deposit the
/// user already approved.
#[derive(Accounts)]
pub struct SetDestination<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ SwishError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(seeds = [APP_SEED, app.app_id.as_ref()], bump = app.bump)]
    pub app: Account<'info, App>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint, token::token_program = token_program)]
    pub token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + AppDestination::INIT_SPACE,
        seeds = [DESTINATION_SEED, app.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub destination: Account<'info, AppDestination>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_destination(ctx: Context<SetDestination>) -> Result<()> {
    ctx.accounts.destination.set_inner(AppDestination {
        app: ctx.accounts.app.key(),
        mint: ctx.accounts.mint.key(),
        token_account: ctx.accounts.token_account.key(),
        bump: ctx.bumps.destination,
    });
    Ok(())
}

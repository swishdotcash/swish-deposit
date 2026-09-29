use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::SwishError,
    state::{App, Config},
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

/// The per-app switch: off refuses every deposit into this app, and nothing
/// else.
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

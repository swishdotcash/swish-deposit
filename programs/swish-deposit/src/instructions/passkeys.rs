use anchor_lang::prelude::*;

use crate::{constants::*, error::SwishError, state::UserPasskey};

fn check_passkey(passkey: &[u8; 33]) -> Result<()> {
    // The precompile rejects a key that is not on the curve; this only
    // rejects the obvious wrong shapes early.
    require!(passkey[0] == 0x02 || passkey[0] == 0x03, SwishError::InvalidPasskey);
    Ok(())
}

#[derive(Accounts)]
pub struct RegisterPasskey<'info> {
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + UserPasskey::INIT_SPACE,
        seeds = [PASSKEY_SEED, wallet.key().as_ref()],
        bump
    )]
    pub user_passkey: Account<'info, UserPasskey>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register_passkey(ctx: Context<RegisterPasskey>, passkey: [u8; 33]) -> Result<()> {
    check_passkey(&passkey)?;
    ctx.accounts.user_passkey.set_inner(UserPasskey {
        wallet: ctx.accounts.wallet.key(),
        passkey,
        next_nonce: Clock::get()?.slot,
        rent_payer: ctx.accounts.payer.key(),
        bump: ctx.bumps.user_passkey,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RotatePasskey<'info> {
    pub wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [PASSKEY_SEED, wallet.key().as_ref()],
        bump = user_passkey.bump,
        has_one = wallet
    )]
    pub user_passkey: Account<'info, UserPasskey>,
}

pub fn handle_rotate_passkey(ctx: Context<RotatePasskey>, passkey: [u8; 33]) -> Result<()> {
    check_passkey(&passkey)?;
    ctx.accounts.user_passkey.passkey = passkey;
    Ok(())
}

#[derive(Accounts)]
pub struct RemovePasskey<'info> {
    pub wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [PASSKEY_SEED, wallet.key().as_ref()],
        bump = user_passkey.bump,
        has_one = wallet,
        has_one = rent_payer,
        close = rent_payer
    )]
    pub user_passkey: Account<'info, UserPasskey>,
    /// CHECK: only receives lamports; must match `user_passkey.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn handle_remove_passkey(_ctx: Context<RemovePasskey>) -> Result<()> {
    Ok(())
}

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::SwishError,
    state::{LinkedWallet, SwishId},
    webauthn::passkey_seed,
};

fn check_passkey(passkey: &[u8; 33]) -> Result<()> {
    // The precompile rejects a key that is not on the curve; this only
    // rejects the obvious wrong shapes early.
    require!(passkey[0] == 0x02 || passkey[0] == 0x03, SwishError::InvalidPasskey);
    Ok(())
}

/// Links a wallet to the Swish ID of `passkey`, creating the Swish ID on first
/// use. Only the wallet's own signature can link it: nobody can attach a
/// wallet that is not theirs. A sponsor may pay the rent.
#[derive(Accounts)]
#[instruction(passkey: [u8; 33])]
pub struct LinkWallet<'info> {
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + SwishId::INIT_SPACE,
        seeds = [SWISH_ID_SEED, passkey_seed(&passkey).as_ref()],
        bump
    )]
    pub swish_id: Account<'info, SwishId>,
    #[account(
        init,
        payer = payer,
        space = 8 + LinkedWallet::INIT_SPACE,
        seeds = [WALLET_SEED, wallet.key().as_ref()],
        bump
    )]
    pub linked_wallet: Account<'info, LinkedWallet>,
    pub system_program: Program<'info, System>,
}

pub fn handle_link_wallet(ctx: Context<LinkWallet>, passkey: [u8; 33]) -> Result<()> {
    check_passkey(&passkey)?;
    let swish_id = &mut ctx.accounts.swish_id;
    if swish_id.passkey == [0u8; 33] {
        // Created just now by init_if_needed.
        swish_id.passkey = passkey;
        swish_id.rent_payer = ctx.accounts.payer.key();
        swish_id.bump = ctx.bumps.swish_id;
    }
    require!(swish_id.passkey == passkey, SwishError::WrongPasskey);
    swish_id.linked_wallets = swish_id
        .linked_wallets
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    ctx.accounts.linked_wallet.set_inner(LinkedWallet {
        wallet: ctx.accounts.wallet.key(),
        swish_id: ctx.accounts.swish_id.key(),
        rent_payer: ctx.accounts.payer.key(),
        bump: ctx.bumps.linked_wallet,
    });
    Ok(())
}

/// Signed by the wallet. Deposits can no longer come from it; rent goes back
/// to whoever paid it.
#[derive(Accounts)]
pub struct UnlinkWallet<'info> {
    pub wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [WALLET_SEED, wallet.key().as_ref()],
        bump = linked_wallet.bump,
        has_one = wallet,
        has_one = swish_id,
        has_one = rent_payer,
        close = rent_payer
    )]
    pub linked_wallet: Account<'info, LinkedWallet>,
    #[account(mut)]
    pub swish_id: Account<'info, SwishId>,
    /// CHECK: only receives lamports; must match `linked_wallet.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn handle_unlink_wallet(ctx: Context<UnlinkWallet>) -> Result<()> {
    let swish_id = &mut ctx.accounts.swish_id;
    swish_id.linked_wallets = swish_id.linked_wallets.saturating_sub(1);
    Ok(())
}

/// Anyone may close a Swish ID with no wallets left; the rent goes back to
/// whoever paid it.
#[derive(Accounts)]
pub struct CloseSwishId<'info> {
    #[account(
        mut,
        seeds = [SWISH_ID_SEED, passkey_seed(&swish_id.passkey).as_ref()],
        bump = swish_id.bump,
        has_one = rent_payer,
        constraint = swish_id.linked_wallets == 0 @ SwishError::SwishIdHasWallets,
        close = rent_payer
    )]
    pub swish_id: Account<'info, SwishId>,
    /// CHECK: only receives lamports; must match `swish_id.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn handle_close_swish_id(_ctx: Context<CloseSwishId>) -> Result<()> {
    Ok(())
}

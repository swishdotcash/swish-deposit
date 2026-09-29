//! Swish Deposit.
//!
//! A user sets up once: their wallet approves an allowance in the Solana
//! Foundation Subscriptions & Allowances program with our `Puller` PDA as the
//! only delegatee, and registers a passkey here. After that, every deposit is
//! a pull that this program allows only when the transaction carries a
//! signature from that passkey over the exact deposit (wallet, allowance, app,
//! mint, destination, amount, nonce, deadline).
//!
//! Nobody can move a user's money without their passkey, Swish included. The
//! Foundation program caps every pull at what the user approved, and the user
//! can revoke the allowance there directly, without us.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod webauthn;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("D2JKE48xP76LQkr1fn41LM8nxG74uKohAXy5SEoPaL3p");

#[program]
pub mod swish_deposit {
    use super::*;

    /// One time, by the program's upgrade authority.
    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        instructions::admin::handle_initialize(ctx, args)
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::handle_propose_admin(ctx, new_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin::handle_accept_admin(ctx)
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::admin::handle_set_paused(ctx, paused)
    }

    pub fn set_rp_id_hash(ctx: Context<AdminOnly>, rp_id_hash: [u8; 32]) -> Result<()> {
        instructions::admin::handle_set_rp_id_hash(ctx, rp_id_hash)
    }

    pub fn register_app(ctx: Context<RegisterApp>, app_id: [u8; 16]) -> Result<()> {
        instructions::apps::handle_register_app(ctx, app_id)
    }

    pub fn set_app_active(ctx: Context<SetAppActive>, active: bool) -> Result<()> {
        instructions::apps::handle_set_app_active(ctx, active)
    }

    pub fn set_destination(ctx: Context<SetDestination>) -> Result<()> {
        instructions::apps::handle_set_destination(ctx)
    }

    /// Signed by the user's wallet. A sponsor may pay the rent.
    pub fn register_passkey(ctx: Context<RegisterPasskey>, passkey: [u8; 33]) -> Result<()> {
        instructions::passkeys::handle_register_passkey(ctx, passkey)
    }

    /// Signed by the user's wallet. Keeps the nonce, so nothing signed for the
    /// old passkey can be replayed.
    pub fn rotate_passkey(ctx: Context<RotatePasskey>, passkey: [u8; 33]) -> Result<()> {
        instructions::passkeys::handle_rotate_passkey(ctx, passkey)
    }

    /// Signed by the user's wallet. Rent goes back to whoever paid it.
    pub fn remove_passkey(ctx: Context<RemovePasskey>) -> Result<()> {
        instructions::passkeys::handle_remove_passkey(ctx)
    }

    /// Anyone may submit; it only works with the user's passkey signature in
    /// the instruction right before it.
    pub fn pull<'info>(ctx: Context<'info, Pull<'info>>, args: PullArgs) -> Result<()> {
        instructions::pull::handle_pull(ctx, args)
    }
}

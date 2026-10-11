//! Swish Deposit.
//!
//! A user's passkey is their Swish ID. Each wallet they link approves an
//! allowance in the Solana Foundation Subscriptions & Allowances program with
//! our `Puller` PDA as the only delegatee, and signs once to link itself to
//! the Swish ID. After that, every deposit is a pull that this program allows
//! only when the transaction carries a signature from that passkey over the
//! exact deposit (a one-time deposit id, app, token, destination, amount,
//! deadline), from a wallet linked to it.
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

include!(concat!(env!("OUT_DIR"), "/program_id.rs"));

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

    /// Signed by the wallet being linked. Creates the Swish ID for `passkey`
    /// on first use. A sponsor may pay the rent.
    pub fn link_wallet(ctx: Context<LinkWallet>, passkey: [u8; 33]) -> Result<()> {
        instructions::wallets::handle_link_wallet(ctx, passkey)
    }

    /// Signed by the wallet. Rent goes back to whoever paid it.
    pub fn unlink_wallet(ctx: Context<UnlinkWallet>) -> Result<()> {
        instructions::wallets::handle_unlink_wallet(ctx)
    }

    /// Anyone, once a Swish ID has no wallets left.
    pub fn close_swish_id(ctx: Context<CloseSwishId>) -> Result<()> {
        instructions::wallets::handle_close_swish_id(ctx)
    }

    /// Anyone may submit; it only works with the user's passkey signature in
    /// the instruction right before it.
    pub fn pull<'info>(ctx: Context<'info, Pull<'info>>, args: PullArgs) -> Result<()> {
        instructions::pull::handle_pull(ctx, args)
    }

    /// Anyone, once the deposit's deadline has passed.
    pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
        instructions::pull::handle_close_receipt(ctx)
    }
}

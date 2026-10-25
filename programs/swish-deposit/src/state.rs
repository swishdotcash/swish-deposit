use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// `Pubkey::default()` when no transfer is in progress.
    pub pending_admin: Pubkey,
    /// Differs per cluster, so a signature made on devnet is useless on mainnet
    /// even though the program address is the same.
    pub cluster_tag: [u8; 32],
    /// sha256 of the WebAuthn relying party id (`swish.cash`).
    pub rp_id_hash: [u8; 32],
    /// [`LIVE`], [`PAUSED`] or [`RETIRED`]. One byte where `paused: bool` was,
    /// so an upgraded deployment reads its existing config unchanged.
    pub status: u8,
    pub bump: u8,
    pub puller_bump: u8,
}

/// An integrator. Registered by the admin; `active` is the per-app switch.
#[account]
#[derive(InitSpace)]
pub struct App {
    pub app_id: [u8; 16],
    pub active: bool,
    pub bump: u8,
}

/// A user's Swish ID: one passkey, any number of linked wallets.
/// Address: [`SWISH_ID_SEED`, sha256(passkey)].
#[account]
#[derive(InitSpace)]
pub struct SwishId {
    /// Compressed P-256 public key of the user's WebAuthn credential.
    pub passkey: [u8; 33],
    pub linked_wallets: u32,
    /// Receives the rent back when the Swish ID is closed.
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// A wallet a Swish ID may deposit from. Created only with that wallet's
/// signature. Address: [`WALLET_SEED`, wallet], so a wallet belongs to at most
/// one Swish ID.
#[account]
#[derive(InitSpace)]
pub struct LinkedWallet {
    pub wallet: Pubkey,
    pub swish_id: Pubkey,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// Permanently marks a deposit id as used. Address: [`RECEIPT_SEED`, deposit_id].
/// A later approval may name the same id with a different deadline, so this
/// account must never be closed, even after this particular approval expires.
#[account]
#[derive(InitSpace)]
pub struct DepositReceipt {
    pub expires_at: i64,
    pub rent_payer: Pubkey,
    pub bump: u8,
    /// Binds all payment details, independently of the approval's deadline.
    pub commitment: [u8; 32],
    pub wallet: Pubkey,
    pub swish_id: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PullKind {
    Fixed,
    Recurring,
}

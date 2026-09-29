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
    pub paused: bool,
    pub bump: u8,
    pub puller_bump: u8,
}

/// An integrator. Registered by the admin after screening.
#[account]
#[derive(InitSpace)]
pub struct App {
    pub app_id: [u8; 16],
    pub active: bool,
    pub bump: u8,
}

/// The one token account an app receives a given mint in.
#[account]
#[derive(InitSpace)]
pub struct AppDestination {
    pub app: Pubkey,
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserPasskey {
    pub wallet: Pubkey,
    /// Compressed P-256 public key of the user's WebAuthn credential.
    pub passkey: [u8; 33],
    /// The nonce the next pull must sign. Starts at the registration slot, so
    /// removing and registering again never reuses a nonce.
    pub next_nonce: u64,
    /// Receives the rent back when the passkey is removed.
    pub rent_payer: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PullKind {
    Fixed,
    Recurring,
}

impl PullKind {
    pub fn as_u8(self) -> u8 {
        match self {
            PullKind::Fixed => 0,
            PullKind::Recurring => 1,
        }
    }
}

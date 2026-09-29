use anchor_lang::prelude::*;

use crate::state::PullKind;

#[event]
pub struct Deposited {
    pub wallet: Pubkey,
    pub app_id: [u8; 16],
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub delegation: Pubkey,
    pub kind: PullKind,
    pub amount: u64,
    pub nonce: u64,
}

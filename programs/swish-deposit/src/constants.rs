use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const APP_SEED: &[u8] = b"app";
#[constant]
pub const DESTINATION_SEED: &[u8] = b"destination";
#[constant]
pub const PASSKEY_SEED: &[u8] = b"passkey";
/// The PDA every allowance names as its delegatee.
#[constant]
pub const PULLER_SEED: &[u8] = b"puller";

/// Prefix of every challenge a passkey signs. Bump the version on any change
/// to what goes into the challenge.
pub const PULL_DOMAIN: &[u8] = b"swish-deposit/pull/v1";

/// The longest a signed deposit stays valid.
pub const MAX_SIGNATURE_LIFETIME_SECS: i64 = 120;

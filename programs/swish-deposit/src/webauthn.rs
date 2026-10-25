//! Checks that the instruction right before a pull is a secp256r1 precompile
//! instruction that verified the user's passkey signing this exact deposit.
//!
//! The runtime runs every precompile instruction before any program runs and
//! fails the whole transaction if a signature is invalid. So if the precompile
//! instruction is in the transaction, its signature is valid; what this module
//! checks is that it verified the RIGHT key over the RIGHT message.
//!
//! A WebAuthn assertion signs `authenticatorData || sha256(clientDataJSON)`,
//! and our challenge sits base64url-encoded inside clientDataJSON.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::secp256r1_program;
use solana_sha256_hasher::{hash, hashv};

use crate::error::SwishError;

const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;
const PUBKEY_LEN: usize = 33;
/// rpIdHash (32) + flags (1) + signCount (4).
const MIN_AUTHENTICATOR_DATA_LEN: usize = 37;
const FLAG_USER_PRESENT: u8 = 0x01;
const FLAG_USER_VERIFIED: u8 = 0x04;
/// Per the WebAuthn spec, browsers serialise these two members first, in this
/// order. Matching the literal prefix avoids parsing JSON on chain.
const CLIENT_DATA_PREFIX: &[u8] = br#"{"type":"webauthn.get","challenge":""#;
const CHALLENGE_B64_LEN: usize = 43;

pub struct PasskeyApproval<'a> {
    pub passkey: &'a [u8; 33],
    pub rp_id_hash: &'a [u8; 32],
    pub challenge: &'a [u8; 32],
    pub client_data_json: &'a [u8],
}

pub fn verify_passkey_approval(instructions: &AccountInfo, approval: PasskeyApproval) -> Result<()> {
    let current = load_current_index_checked(instructions)? as usize;
    require!(current > 0, SwishError::MissingPasskeySignature);
    let ix = load_instruction_at_checked(current - 1, instructions)?;
    require!(
        ix.program_id.to_bytes() == secp256r1_program::ID.to_bytes(),
        SwishError::MissingPasskeySignature
    );

    let data = ix.data.as_slice();
    require!(
        data.len() >= OFFSETS_START + OFFSETS_LEN && data[0] == 1,
        SwishError::MalformedPasskeySignature
    );
    let offsets = &data[OFFSETS_START..OFFSETS_START + OFFSETS_LEN];
    let field = |i: usize| u16::from_le_bytes([offsets[i * 2], offsets[i * 2 + 1]]);
    let signature_ix_index = field(1);
    let pubkey_offset = field(2) as usize;
    let pubkey_ix_index = field(3);
    let message_offset = field(4) as usize;
    let message_len = field(5) as usize;
    let message_ix_index = field(6);
    // u16::MAX = "in this same instruction". Anything else would let the key
    // or message the precompile verified differ from what we read below.
    require!(
        signature_ix_index == u16::MAX && pubkey_ix_index == u16::MAX && message_ix_index == u16::MAX,
        SwishError::MalformedPasskeySignature
    );

    let pubkey = data
        .get(pubkey_offset..pubkey_offset + PUBKEY_LEN)
        .ok_or(SwishError::MalformedPasskeySignature)?;
    require!(pubkey == approval.passkey.as_slice(), SwishError::WrongPasskey);

    let message = data
        .get(message_offset..message_offset + message_len)
        .ok_or(SwishError::MalformedPasskeySignature)?;
    require!(
        message.len() >= MIN_AUTHENTICATOR_DATA_LEN + 32,
        SwishError::MalformedPasskeySignature
    );
    let (authenticator_data, client_data_hash) = message.split_at(message.len() - 32);

    require!(
        authenticator_data[..32] == approval.rp_id_hash[..],
        SwishError::WrongRelyingParty
    );
    let flags = authenticator_data[32];
    require!(
        flags & FLAG_USER_PRESENT != 0 && flags & FLAG_USER_VERIFIED != 0,
        SwishError::UserNotVerified
    );

    require!(
        hash(approval.client_data_json).to_bytes()[..] == client_data_hash[..],
        SwishError::ClientDataMismatch
    );
    let challenge_b64 = base64url_32(approval.challenge);
    let json = approval.client_data_json;
    let start = CLIENT_DATA_PREFIX.len();
    require!(
        json.len() > start + CHALLENGE_B64_LEN
            && json.starts_with(CLIENT_DATA_PREFIX)
            && json[start..start + CHALLENGE_B64_LEN] == challenge_b64[..]
            && json[start + CHALLENGE_B64_LEN] == b'"',
        SwishError::ChallengeMismatch
    );
    Ok(())
}

/// Everything a passkey approves for one pull. Only things known BEFORE we
/// know who the user is, so a single Face ID both identifies and approves:
/// the program learns the user from the passkey that signed. Every field is
/// fixed-size, so the concatenation is unambiguous.
///
/// Which linked wallet pays and which of its allowances is used are not
/// signed: all of them are the user's own, each within its own limit.
pub struct PullChallenge<'a> {
    pub cluster_tag: &'a [u8; 32],
    pub program_id: &'a Pubkey,
    pub deposit_id: &'a [u8; 16],
    pub app_id: &'a [u8; 16],
    pub mint: &'a Pubkey,
    pub destination: &'a Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}

impl PullChallenge<'_> {
    /// Identifies the payment independently of a particular approval's deadline.
    /// Refreshed approvals for the same payment must reconcile to the same receipt.
    pub fn payment_commitment(&self) -> [u8; 32] {
        hashv(&[
            b"swish-deposit/receipt/v1",
            self.cluster_tag,
            self.program_id.as_ref(),
            self.deposit_id,
            self.app_id,
            self.mint.as_ref(),
            self.destination.as_ref(),
            &self.amount.to_le_bytes(),
        ])
        .to_bytes()
    }

    pub fn hash(&self) -> [u8; 32] {
        hashv(&[
            crate::constants::PULL_DOMAIN,
            self.cluster_tag,
            self.program_id.as_ref(),
            self.deposit_id,
            self.app_id,
            self.mint.as_ref(),
            self.destination.as_ref(),
            &self.amount.to_le_bytes(),
            &self.expires_at.to_le_bytes(),
        ])
        .to_bytes()
    }
}

/// The Swish ID address seed for a passkey (33 bytes is over the 32-byte seed
/// limit, so it is hashed).
pub fn passkey_seed(passkey: &[u8; 33]) -> [u8; 32] {
    hash(passkey).to_bytes()
}

/// Unpadded base64url of 32 bytes (43 characters), as WebAuthn encodes the
/// challenge in clientDataJSON.
pub fn base64url_32(bytes: &[u8; 32]) -> [u8; CHALLENGE_B64_LEN] {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = [0u8; CHALLENGE_B64_LEN];
    let mut o = 0;
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out[o] = ALPHABET[((n >> (18 - 6 * i)) & 63) as usize];
            o += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_known_vectors() {
        let zeros = [0u8; 32];
        assert_eq!(&base64url_32(&zeros), b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        let ones = [0xffu8; 32];
        assert_eq!(&base64url_32(&ones), b"__________________________________________8");
        let mut seq = [0u8; 32];
        for (i, b) in seq.iter_mut().enumerate() {
            *b = i as u8;
        }
        // python3 -c "import base64;print(base64.urlsafe_b64encode(bytes(range(32))).rstrip(b'='))"
        assert_eq!(&base64url_32(&seq), b"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    }
}

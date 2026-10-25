use anchor_lang::prelude::*;

#[error_code]
pub enum SwishError {
    #[msg("Only the program's upgrade authority can initialize")]
    NotUpgradeAuthority,
    #[msg("Only the admin can do this")]
    NotAdmin,
    #[msg("Only the proposed admin can accept")]
    NotPendingAdmin,
    #[msg("Deposits are paused")]
    Paused,
    #[msg("This app is not active")]
    AppInactive,
    #[msg("A passkey public key must be a compressed P-256 point (33 bytes, 0x02 or 0x03 first)")]
    InvalidPasskey,
    #[msg("The instruction before a pull must be a secp256r1 signature check")]
    MissingPasskeySignature,
    #[msg("The secp256r1 instruction must check exactly one signature, with all data inside itself")]
    MalformedPasskeySignature,
    #[msg("The signature is not from this Swish ID's passkey")]
    WrongPasskey,
    #[msg("The passkey signed for a different site")]
    WrongRelyingParty,
    #[msg("The passkey did not confirm the user was present and verified")]
    UserNotVerified,
    #[msg("The signed client data does not match")]
    ClientDataMismatch,
    #[msg("The passkey signed a different deposit")]
    ChallengeMismatch,
    #[msg("The signed deposit has expired")]
    SignatureExpired,
    #[msg("The deadline is too far in the future")]
    DeadlineTooFar,
    #[msg("Amount must be above zero")]
    ZeroAmount,
    #[msg("This allowance does not belong to this wallet, this program, or this token")]
    WrongDelegation,
    #[msg("A pull must be a top-level instruction")]
    CpiNotAllowed,
    #[msg("This wallet is not linked to this Swish ID")]
    WalletNotLinked,
    #[msg("A receipt can only be closed after its deposit's deadline")]
    ReceiptNotExpired,
    #[msg("Unlink every wallet before closing a Swish ID")]
    SwishIdHasWallets,
    #[msg("Deposit receipts can only be closed once Swish Deposit is retired")]
    ReceiptPermanent,
    #[msg("Swish Deposit is retired")]
    Retired,
}

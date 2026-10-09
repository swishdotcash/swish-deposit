use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=SWISH_PROGRAM_ID");
    let id = env::var("SWISH_PROGRAM_ID")
        .expect("SWISH_PROGRAM_ID is required to build the program; set it in services/api/.env and use npm run program:build");
    const BASE58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    assert!(
        (32..=44).contains(&id.len()) && id.chars().all(|c| BASE58.contains(c)),
        "SWISH_PROGRAM_ID must be a Solana program address"
    );
    let output = PathBuf::from(env::var("OUT_DIR").expect("Cargo must set OUT_DIR"));
    fs::write(output.join("program_id.rs"), format!("declare_id!(\"{id}\");\n"))
        .expect("failed to write the program ID for this build");
}

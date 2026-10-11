import { p256 } from "@noble/curves/nist.js";
import { address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { pullChallenge, sha256 } from "../src/chain/program.js";
import {
  PasskeyError,
  b64url,
  compressPublicKey,
  derToLowSCompact,
  secp256r1Instruction,
  verifyAssertion,
} from "../src/chain/webauthn.js";
import { fromBaseUnits, toBaseUnits } from "../src/amount.js";
import { fakePasskey } from "./helpers.js";

const bytes = (n: number, len: number) => new Uint8Array(len).fill(n);
const addr = (n: number) => getAddressDecoder().decode(bytes(n, 32));

describe("the challenge", () => {
  it("is exactly what the program hashes (same vector as tests/pull.rs)", () => {
    const hash = pullChallenge({
      clusterTag: bytes(1, 32),
      programId: address("D2JKE48xP76LQkr1fn41LM8nxG74uKohAXy5SEoPaL3p"),
      depositId: bytes(5, 16),
      appId: bytes(6, 16),
      mint: addr(3),
      destination: addr(4),
      amount: 12_500_000n,
      expiresAt: 1_790_000_090n,
    });
    expect(Buffer.from(hash).toString("hex")).toBe("76f08a1b0bb339ed8201b153cd2572be73d9fc518e8024b8a180e53961b4420f");
  });
});

describe("passkey approvals", () => {
  const challenge = bytes(9, 32);

  it("reads the key browsers hand over (SPKI) as the compressed key the program stores", () => {
    const pk = fakePasskey();
    expect(compressPublicKey(pk.spki)).toEqual(pk.publicKey);
    expect(() => compressPublicKey(bytes(7, 33))).toThrow(PasskeyError);
  });

  it("accepts a real approval and builds the precompile instruction the program reads", () => {
    const pk = fakePasskey();
    const { compactSignature, message } = verifyAssertion(pk.publicKey, pk.assert(challenge), { rpId: "localhost", challenge });
    const ix = secp256r1Instruction(pk.publicKey, compactSignature, message);
    const data = Buffer.from(ix.data!);
    expect(data[0]).toBe(1);
    const field = (i: number) => data.readUInt16LE(2 + i * 2);
    expect([field(1), field(3), field(6)]).toEqual([0xffff, 0xffff, 0xffff]);
    expect(data.subarray(field(2), field(2) + 33)).toEqual(Buffer.from(pk.publicKey));
    expect(data.subarray(field(4), field(4) + field(5))).toEqual(Buffer.from(message));
  });

  it("turns a high-S signature into the low-S one the runtime accepts", () => {
    const pk = fakePasskey();
    const a = pk.assert(challenge, { highS: true });
    const compact = derToLowSCompact(a.signature);
    const s = BigInt("0x" + Buffer.from(compact.subarray(32)).toString("hex"));
    expect(s <= p256.Point.Fn.ORDER >> 1n).toBe(true);
    expect(() => verifyAssertion(pk.publicKey, a, { rpId: "localhost", challenge })).not.toThrow();
  });

  it.each([
    ["another site", { rpId: "evil.example" }, /different site/],
    ["no user verification", { flags: 0x01 }, /did not verify/],
    ["a registration, not an approval", { type: "webauthn.create" }, /different deposit/],
  ])("refuses %s", (_name, opts, error) => {
    const pk = fakePasskey();
    expect(() => verifyAssertion(pk.publicKey, pk.assert(challenge, opts), { rpId: "localhost", challenge })).toThrow(error);
  });

  it("refuses an approval for another deposit, or from another passkey", () => {
    const pk = fakePasskey();
    expect(() =>
      verifyAssertion(pk.publicKey, pk.assert(bytes(8, 32)), { rpId: "localhost", challenge }),
    ).toThrow(/different deposit/);
    expect(() =>
      verifyAssertion(fakePasskey().publicKey, pk.assert(challenge), { rpId: "localhost", challenge }),
    ).toThrow(/not from this passkey/);
  });
});

describe("amounts", () => {
  it("converts both ways without floats", () => {
    expect(toBaseUnits("12.5", 6)).toBe(12_500_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
    expect(fromBaseUnits(12_500_000n, 6)).toBe("12.5");
    expect(fromBaseUnits("1", 6)).toBe("0.000001");
    expect(() => toBaseUnits("1.0000001", 6)).toThrow();
    expect(() => toBaseUnits("-1", 6)).toThrow();
    expect(() => toBaseUnits("1e3", 6)).toThrow();
  });
});

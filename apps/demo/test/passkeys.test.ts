import { afterEach, expect, it, vi } from "vitest";
import { demoPasskeys } from "../src/passkeys";
import { PasskeyDismissed } from "core/passkey";
afterEach(() => vi.unstubAllGlobals());
function credentials() {
  const rawId = new TextEncoder().encode("cred").buffer;
  const get = vi.fn(async () => ({
    rawId,
    response: {
      authenticatorData: rawId,
      clientDataJSON: rawId,
      signature: rawId,
    },
  }));
  vi.stubGlobal("navigator", { credentials: { get } });
  vi.stubGlobal("PublicKeyCredential", class {});
  return get;
}
it("restricts payment approval to the credential linked to the wallet", async () => {
  const get = credentials();
  const approval = await demoPasskeys().approve(
    "Y2hhbGxlbmdl",
    "localhost",
    "Y3JlZA",
  );
  const request = get.mock.calls[0][0] as CredentialRequestOptions;
  expect(request.publicKey?.allowCredentials).toHaveLength(1);
  expect(
    new TextDecoder().decode(
      request.publicKey!.allowCredentials![0]!.id as ArrayBuffer,
    ),
  ).toBe("cred");
  expect(approval.credentialId).toBe("Y3JlZA");
});
it("keeps passkey discovery open for a new device", async () => {
  const get = credentials();
  await demoPasskeys().approve("Y2hhbGxlbmdl", "localhost");
  const request = get.mock.calls[0][0] as CredentialRequestOptions;
  expect(request.publicKey?.allowCredentials).toEqual([]);
});
it("treats a cancelled credential prompt as a cancellation", async () => {
  const get = credentials();
  get.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
  await expect(
    demoPasskeys().approve("Y2hhbGxlbmdl", "localhost", "Y3JlZA"),
  ).rejects.toBeInstanceOf(PasskeyDismissed);
});

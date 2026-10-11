// Verifies a minisign signature (the format `tauri signer sign` writes, base64 of the .minisig
// text) with Node built-ins only. The client checks the same signature in
// crates/otterm-app/src/registry.rs; this lets validate.mjs catch an index changed after signing.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_KEY_FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "registry-key.pub");

// The DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow.
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** The lines of a base64-wrapped minisign file (`untrusted comment: …`, then the data lines). */
function lines(base64Text) {
  return Buffer.from(base64Text.trim(), "base64").toString("utf8").split(/\r?\n/);
}

/** Throws unless `signatureB64` is a valid signature of `data` by the key in `publicKeyB64`. */
export function verifyMinisign(data, signatureB64, publicKeyB64) {
  const key = Buffer.from(lines(publicKeyB64)[1] ?? "", "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed") throw new Error("not a minisign public key");
  const [, sigLine, trustedLine, globalLine] = lines(signatureB64);
  const sig = Buffer.from(sigLine ?? "", "base64");
  if (sig.length !== 74) throw new Error("not a minisign signature");
  const algorithm = sig.subarray(0, 2).toString();
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error(`unknown signature algorithm ${algorithm}`);
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) throw new Error("signed with a different key");
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI, key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  // "ED" signs the BLAKE2b-512 hash of the file; legacy "Ed" signs the file itself.
  const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, publicKey, sig.subarray(10))) throw new Error("the signature does not match");
  // The global signature covers the signature and the trusted comment, so neither can be swapped.
  const trusted = (trustedLine ?? "").replace(/^trusted comment: /, "");
  const global = Buffer.from(globalLine ?? "", "base64");
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), publicKey, global))
    throw new Error("the trusted comment does not match");
}

/** Verify `file` against `file.sig` and registry-key.pub. */
export async function verifyFile(file) {
  const [data, sig, pub] = await Promise.all([
    readFile(file),
    readFile(`${file}.sig`, "utf8"),
    readFile(PUBLIC_KEY_FILE, "utf8"),
  ]);
  verifyMinisign(data, sig, pub);
}

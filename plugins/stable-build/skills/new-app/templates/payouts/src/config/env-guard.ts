// Private keys must never reach a VITE_* variable: Vite copies those values into the public bundle.
// This module has no imports so vite.config.ts and the CLI can load it cheaply.

const PRIVATE_KEY_SHAPE = /^(0x)?[0-9a-fA-F]{64}$/;

/** True when a value has the shape of a 32-byte private key. */
export function looksLikePrivateKey(value: unknown): boolean {
  return typeof value === "string" && PRIVATE_KEY_SHAPE.test(value.trim());
}

/** Names of VITE_* variables whose value looks like a private key. */
export function leakedViteKeys(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => k.startsWith("VITE_") && looksLikePrivateKey(v))
    .map(([k]) => k)
    .sort();
}

export function leakMessage(keys: string[]): string {
  return `${keys.join(", ")} ${keys.length === 1 ? "looks" : "look"} like a private key. Every VITE_* value is published in the site bundle: remove it from the environment and .env files, rotate that key, and build again.`;
}

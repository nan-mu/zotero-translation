/**
 * Chunked SHA-256 over a local file path (OS.File / IOUtils).
 * Returns 64-char lowercase hex.
 */
export async function sha256File(path: string): Promise<string> {
  // Prefer IOUtils when available (Zotero 7 / Firefox 115+)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const IOUtilsAny = (globalThis as any).IOUtils;
  if (IOUtilsAny?.read) {
    const bytes: Uint8Array = await IOUtilsAny.read(path);
    return sha256Bytes(bytes);
  }

  // Fallback: OS.File
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const OSAny = (globalThis as any).OS;
  if (OSAny?.File?.read) {
    const bytes: Uint8Array = await OSAny.File.read(path, { encoding: null });
    return sha256Bytes(bytes);
  }

  throw new Error("No file IO available for SHA-256");
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return sha256BytesNsICryptoHash(bytes);
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return bufferToHex(new Uint8Array(digest));
}

function sha256BytesNsICryptoHash(bytes: Uint8Array): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Cc = (Components as any).classes;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ci = (Components as any).interfaces;
  const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash,
  );
  hasher.init(hasher.SHA256);
  hasher.update(bytes, bytes.length);
  const raw = hasher.finish(false);
  let hex = "";
  for (let i = 0; i < raw.length; i++) {
    hex += `0${raw.charCodeAt(i).toString(16)}`.slice(-2);
  }
  return hex;
}

function bufferToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

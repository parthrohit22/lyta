const encoder = new TextEncoder()
// Tuned for the Workers runtime so auth stays responsive without
// triggering edge CPU spikes during register/login.
const PBKDF2_ITERATIONS = 100_000

export interface PasswordRecord {
  hash: string
  salt: string
}

export function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}

export function createSessionToken() {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`
}

export async function createPasswordRecord(
  password: string
): Promise<PasswordRecord> {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))

  return {
    salt,
    hash: await derivePasswordHash(password, salt)
  }
}

export async function verifyPassword(
  password: string,
  record: PasswordRecord
) {
  const hash = await derivePasswordHash(password, record.salt)

  return hash === record.hash
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(token)
  )

  return bytesToHex(new Uint8Array(digest))
}

async function derivePasswordHash(password: string, saltHex: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ITERATIONS
    },
    key,
    256
  )

  return bytesToHex(new Uint8Array(bits))
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
}

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2)

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      hex.slice(index * 2, index * 2 + 2),
      16
    )
  }

  return bytes
}

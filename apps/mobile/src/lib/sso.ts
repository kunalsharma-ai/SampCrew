/**
 * Single sign-on in the app. The app makes its own PKCE pair, sends only the challenge when it starts the sign-in,
 * and opens the identity provider in the system browser. After the provider signs the person in, the Web Portal
 * sends the browser back to the app's address (crew://sso, or /sso in the browser preview) with a one-time code.
 * The app exchanges the code together with the verifier, so a code caught on the way is useless to anyone else.
 * Codes live two minutes and work once.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding (RFC 4648 section 5), as PKCE uses. */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** A PKCE pair (S256): 32 random bytes as the verifier, and the base64url SHA-256 of it as the challenge. */
export async function makePkce(randomBytes: (n: number) => Uint8Array, sha256: (text: string) => Promise<Uint8Array>): Promise<Pkce> {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(await sha256(verifier)) };
}

/** Reads the one-time code from the address the browser came back to. */
export function readHandoff(url: string, expected: string): { code: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { error: 'The sign-in did not come back to the app. Start again.' };
  }
  const e = new URL(expected);
  // Custom schemes (crew://sso) put "sso" in the host; web addresses in the path.
  const same = u.protocol === e.protocol && u.host === e.host && u.pathname.replace(/\/$/, '') === e.pathname.replace(/\/$/, '');
  if (!same) return { error: 'The sign-in came back to an unexpected address. Start again.' };
  const code = u.searchParams.get('code');
  if (!code || code.length < 20 || code.length > 100) return { error: 'The sign-in did not return a code. Start again.' };
  return { code };
}

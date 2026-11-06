// Encrypts or decrypts a backup file with BACKUP_PASSPHRASE: AES-256-GCM with a key from scrypt and a random salt
// and IV per file. GCM authenticates the whole file, so a changed or truncated backup fails to decrypt instead of
// restoring damaged data. Decrypted output is written to a temporary name and only renamed once it verifies.
//
//   node crypt.mjs encrypt <in> <out>
//   node crypt.mjs decrypt <in> <out>
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream, openSync, readSync, closeSync, statSync, renameSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('CREWBK1\n');
const [mode, input, output] = process.argv.slice(2);
const pass = process.env.BACKUP_PASSPHRASE;
if (!['encrypt', 'decrypt'].includes(mode) || !input || !output) {
  console.error('usage: crypt.mjs encrypt|decrypt <in> <out>');
  process.exit(2);
}
if (!pass || pass.length < 16) {
  console.error('BACKUP_PASSPHRASE must be set (16 characters or more)');
  process.exit(2);
}
const key = (salt) => scryptSync(pass, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const tmp = `${output}.partial`;

try {
  if (mode === 'encrypt') {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(salt), iv);
    const out = createWriteStream(tmp);
    out.write(Buffer.concat([MAGIC, salt, iv]));
    await pipeline(createReadStream(input), cipher, out, { end: false });
    out.end(cipher.getAuthTag());
    await new Promise((res, rej) => out.on('finish', res).on('error', rej));
  } else {
    const size = statSync(input).size;
    const head = Buffer.alloc(MAGIC.length + 28);
    const tag = Buffer.alloc(16);
    const fd = openSync(input, 'r');
    readSync(fd, head, 0, head.length, 0);
    readSync(fd, tag, 0, 16, size - 16);
    closeSync(fd);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a SampCrew encrypted backup');
    const salt = head.subarray(MAGIC.length, MAGIC.length + 16);
    const iv = head.subarray(MAGIC.length + 16);
    const decipher = createDecipheriv('aes-256-gcm', key(salt), iv);
    decipher.setAuthTag(tag);
    await pipeline(createReadStream(input, { start: head.length, end: size - 17 }), decipher, createWriteStream(tmp));
  }
  renameSync(tmp, output);
} catch (e) {
  rmSync(tmp, { force: true });
  console.error(mode === 'decrypt' ? `cannot decrypt ${input}: wrong passphrase or damaged file (${e.message})` : e.message);
  process.exit(1);
}

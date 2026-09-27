// Generate a kitchen password hash for the server-only KITCHEN_USERS env var.
//
// Usage (interactive, input hidden):   node scripts/hash-kitchen-password.mjs
// Usage (piped, e.g. from a password manager CLI):  <cmd> | node scripts/hash-kitchen-password.mjs
//
// Prints ONLY the hash (format: scrypt$N$r$p$<salt b64url>$<key b64url>), which is what lib/kitchenAuth.ts verifies.
// Nothing is written to disk. Never paste the plaintext password into source files, chat, or commits.

import { randomBytes, scryptSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Must match SCRYPT_DEFAULTS in lib/kitchenAuth.ts
const N = 32768, r = 8, p = 1, KEY_LENGTH = 64, SALT_LENGTH = 16
const MIN_PASSWORD_LENGTH = 12

export function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH)
  const key = scryptSync(password, salt, KEY_LENGTH, { N, r, p, maxmem: 128 * 1024 * 1024 })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

function readHidden(prompt) {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin
    process.stderr.write(prompt)
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = ch => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData)
        process.stderr.write('\n')
        resolvePromise(value)
      } else if (ch === '\u0003') {
        stdin.setRawMode(false); process.stderr.write('\n'); reject(new Error('cancelled'))
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1)
      } else {
        value += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function readPiped() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data.split(/\r?\n/)[0]
}

async function main() {
  let password
  if (process.stdin.isTTY) {
    password = await readHidden('Kitchen password (hidden): ')
    const confirm = await readHidden('Repeat password: ')
    if (password !== confirm) { console.error('Passwords do not match.'); process.exit(1) }
  } else {
    password = await readPiped()
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
    process.exit(1)
  }
  process.stdout.write(hashPassword(password) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}

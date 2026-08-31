#!/usr/bin/env node
/**
 * Downloads missing Midnight KZG trusted-setup params (bls_midnight_2p*) from
 * Midnight's S3 bucket. The nightAction circuit requires 2p15; your public dir
 * may only have up to 2p14.
 *
 * Source: midnight-ledger flake.nix (ledger-8.0.2)
 *   https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const paramsDir = path.resolve(__dirname, '../public/midnight-prover')
const BASE_URL =
  'https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com'

const K_VALUES = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]

async function main() {
  fs.mkdirSync(paramsDir, { recursive: true })

  for (const k of K_VALUES) {
    const name = `bls_midnight_2p${k}`
    const filePath = path.join(paramsDir, name)
    if (fs.existsSync(filePath)) {
      console.log(`[skip] ${name} (exists)`)
      continue
    }
    const url = `${BASE_URL}/${name}`
    console.log(`[fetch] ${url}`)
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[warn] ${name}: HTTP ${res.status}`)
      continue
    }
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(filePath, buf)
    console.log(`[ok] ${name} (${(buf.length / 1024).toFixed(1)} KB)`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

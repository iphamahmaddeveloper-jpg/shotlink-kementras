// Script bantu untuk urusan di luar aplikasi. Dijalankan dari komputer sendiri.
//
//   node scripts/tools.mjs create-admin <username> <password> "<Nama>" "<Instansi>"
//       Mencetak perintah wrangler untuk memasukkan akun admin ke KV.
//
//   node scripts/tools.mjs export <namespace-id> [file]
//   node scripts/tools.mjs import <namespace-id> [file]
//       Salin akun + tautan dari satu KV namespace ke namespace lain (serah terima akun).
//       Butuh env CF_ACCOUNT_ID dan CF_API_TOKEN (izin "Workers KV Storage: Edit").
//       Untuk import ke akun lain, pakai ID dan token milik akun tujuan.
//       Sesi login dan cache statistik tidak ikut dipindah.

import { readFileSync, writeFileSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const [command, ...args] = process.argv.slice(2);

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function usage() {
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 12).join("\n").replace(/^\/\/ ?/gm, ""));
  process.exit(1);
}

async function createAdmin([username, password, name, instansi]) {
  if (!username || !password || !name || !instansi) usage();
  if (password.length < 6) {
    console.error("Password minimal 6 karakter");
    process.exit(1);
  }

  const salt = hex(crypto.getRandomValues(new Uint8Array(24)));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(salt),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );
  
  const record = {
    passwordHash: `pbkdf2$${hex(new Uint8Array(derivedBits))}`,
    salt,
    name,
    instansi,
    role: "superadmin",
    status: "active",
    hashVersion: 2,
    createdAt: Date.now()
  };

  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const namespaceId = wrangler.match(/^id\s*=\s*"([^"]+)"/m)?.[1];

  console.log("Jalankan perintah ini:\n");
  console.log(`npx wrangler kv key put "user:${username.trim().toLowerCase()}" '${JSON.stringify(record)}' --namespace-id ${namespaceId} --remote`);
}

// ---- export / import lewat Cloudflare API ----

const SKIP = ["session:", "rl:", "_stats", "hourclicks:"];

function kvApi(namespaceId) {
  const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    console.error("Isi dulu env CF_ACCOUNT_ID dan CF_API_TOKEN");
    process.exit(1);
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}`;

  return async (path, options = {}) => {
    const res = await fetch(base + path, {
      ...options,
      headers: { Authorization: `Bearer ${CF_API_TOKEN}`, ...options.headers }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res;
  };
}

async function exportData([namespaceId, file = "kv-export.json"]) {
  if (!namespaceId) usage();
  const call = kvApi(namespaceId);

  const names = [];
  let cursor = "";
  do {
    const body = await (await call(`/keys?limit=1000${cursor ? `&cursor=${cursor}` : ""}`)).json();
    names.push(...body.result.map((k) => k.name));
    cursor = body.result_info?.cursor || "";
  } while (cursor);

  const items = [];
  for (const key of names.filter((n) => !SKIP.some((p) => n.startsWith(p)))) {
    items.push({ key, value: await (await call(`/values/${encodeURIComponent(key)}`)).text() });
  }

  writeFileSync(file, JSON.stringify(items, null, 2));
  console.log(`${items.length} key disimpan ke ${file}`);
}

async function importData([namespaceId, file = "kv-export.json"]) {
  if (!namespaceId) usage();
  const call = kvApi(namespaceId);
  const items = JSON.parse(readFileSync(file, "utf8"));

  for (let i = 0; i < items.length; i += 500) {
    await call("/bulk", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(items.slice(i, i + 500))
    });
  }
  console.log(`${items.length} key diimpor ke namespace ${namespaceId}`);
}

const commands = { "create-admin": createAdmin, export: exportData, import: importData };
if (!commands[command]) usage();
await commands[command](args);

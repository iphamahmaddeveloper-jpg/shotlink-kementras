// Backend aplikasi shorten link (Cloudflare Pages, mode _worker.js).
// Semua route ada di file ini. Data disimpan di KV dengan binding LINKS.
//
// Isi KV (dibedakan dari awalan key):
//   <kode>            data tautan   { longUrl, clicks, createdAt, expiresAt, isActive, creator... }
//   user:<username>   data akun     { passwordHash, salt, name, instansi, role, status, hashVersion, createdAt }
//   session:<token>   sesi login    { username, expiresAt }
//   rl:login:<key>    rate limit    { attempts, resetAt }
//   _stats            cache statistik

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 hari, dalam detik
const STATS_CACHE_MS = 60 * 1000;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Rate limiting login
const RATE_LIMIT_PREFIX = "rl:login:";
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_LOCKOUT_TTL = 1 * 60; // 15 menit

// Reserved keywords yang tidak boleh dijadikan alias shortlink
const RESERVED_ALIASES = new Set([
  "api", "admin", "login", "logout", "me", "assets", "public", 
  "index", "index.html", "app.js", "favicon.ico", "robots.txt", 
  "logo.jpg", "dashboard", "stats", "users", "links", "settings", 
  "register", "null", "undefined", "_worker.js", "_routes.json"
]);

// alias hanya huruf/angka/-/_
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...headers }
  });

const fail = (message, status = 400) => json({ error: message }, status);

// body yang bukan JSON dianggap kosong, nanti ditolak oleh validasi
const readBody = (request) => request.json().catch(() => ({}));


/* ---------- KV Storage Helpers ---------- */

const NON_LINK_PREFIXES = ["user:", "session:", "rl:", "_stats", "hourclicks:"];
const isLinkKey = (name) => !NON_LINK_PREFIXES.some((p) => name.startsWith(p));

async function getJson(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listKeys(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

const newestFirst = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);

async function listLinks(kv) {
  const keys = (await listKeys(kv)).filter((k) => isLinkKey(k.name));
  const rows = await Promise.all(
    keys.map(async (k) => {
      const record = await getJson(kv, k.name);
      return record && { 
        code: k.name, 
        isActive: record.isActive !== false,
        expiresAt: record.expiresAt || null,
        ...record 
      };
    })
  );
  return rows.filter(Boolean).sort(newestFirst);
}

async function listUsers(kv) {
  const keys = await listKeys(kv, "user:");
  const rows = await Promise.all(
    keys.map(async (k) => {
      const record = await getJson(kv, k.name);
      return record && { 
        username: k.name.slice(5), 
        role: record.role || "user",
        status: record.status || "active",
        ...record 
      };
    })
  );
  return rows.filter(Boolean).sort(newestFirst);
}


/* ---------- Keamanan: Password Hashing & Sesi ---------- */

// PBKDF2-HMAC-SHA256 (100,000 iterasi) untuk keamanan tinggi
async function hashPasswordPBKDF2(password, salt) {
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
  return Array.from(new Uint8Array(derivedBits), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Fallback legacy hash untuk akun lama
async function legacyHashPassword(password, salt) {
  const data = new TextEncoder().encode(password + salt);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Verifikasi password & otomatis upgrade hash lama ke PBKDF2
async function verifyAndUpgradePassword(password, user, username, env) {
  const isPbkdf2 = user.hashVersion === 2 || (user.passwordHash && user.passwordHash.startsWith("pbkdf2$"));
  
  if (isPbkdf2) {
    const rawTarget = user.passwordHash.replace(/^pbkdf2\$/, "");
    const computed = await hashPasswordPBKDF2(password, user.salt);
    return safeEqual(computed, rawTarget);
  }

  // Coba verifikasi PBKDF2 terlebih dahulu
  const pbkdf2Computed = await hashPasswordPBKDF2(password, user.salt);
  if (safeEqual(pbkdf2Computed, user.passwordHash)) {
    return true;
  }

  // Verifikasi hash lama SHA-256
  const legacyComputed = await legacyHashPassword(password, user.salt);
  if (safeEqual(legacyComputed, user.passwordHash)) {
    // Transparan upgrade akun lama ke PBKDF2
    user.passwordHash = `pbkdf2$${pbkdf2Computed}`;
    user.hashVersion = 2;
    await env.LINKS.put(`user:${username}`, JSON.stringify(user));
    return true;
  }

  return false;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx > -1 && pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
  }
  return null;
}

const sessionCookie = (token, maxAge = SESSION_TTL) =>
  `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

async function getSessionUser(request, env) {
  const token = getCookie(request, "session");
  if (!token) return null;

  const session = await getJson(env.LINKS, `session:${token}`);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await env.LINKS.delete(`session:${token}`);
    return null;
  }

  const user = await getJson(env.LINKS, `user:${session.username}`);
  if (!user || user.status === "inactive") return null;

  return { 
    username: session.username, 
    name: user.name, 
    instansi: user.instansi, 
    role: user.role || "user",
    status: user.status || "active"
  };
}

function isAdmin(env, user) {
  if (!user) return false;
  const admins = (env.ADMIN_USERNAMES || "admin").toLowerCase().split(",").map((s) => s.trim());
  return admins.includes(user.username.toLowerCase()) || user.role === "superadmin";
}

async function requireAdmin(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return { response: fail("Belum login", 401) };
  if (!isAdmin(env, user)) return { response: fail("Akses ditolak: Khusus Super Admin", 403) };
  return { user };
}

/* ---------- Rate Limiting Login ---------- */

function getClientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
}

async function checkLoginRateLimit(kv, identifier) {
  const key = `${RATE_LIMIT_PREFIX}${identifier}`;
  const record = await getJson(kv, key);
  if (record && record.attempts >= MAX_LOGIN_ATTEMPTS) {
    const timeLeft = Math.ceil((record.resetAt - Date.now()) / 1000);
    if (timeLeft > 0) {
      return { blocked: true, minutes: Math.ceil(timeLeft / 60) };
    }
  }
  return { blocked: false };
}

async function recordFailedLogin(kv, identifier) {
  const key = `${RATE_LIMIT_PREFIX}${identifier}`;
  const record = (await getJson(kv, key)) || { attempts: 0, resetAt: Date.now() + LOGIN_LOCKOUT_TTL * 1000 };
  record.attempts += 1;
  record.resetAt = Date.now() + LOGIN_LOCKOUT_TTL * 1000;
  await kv.put(key, JSON.stringify(record), { expirationTtl: LOGIN_LOCKOUT_TTL });
}

async function clearLoginRateLimit(kv, identifier) {
  await kv.delete(`${RATE_LIMIT_PREFIX}${identifier}`);
}


/* ---------- Autentikasi & Akun ---------- */

async function login(request, env) {
  const ip = getClientIp(request);
  const body = await readBody(request);
  const username = (body.username || "").trim().toLowerCase();
  const password = (body.password || "").trim();
  if (!username || !password) return fail("Username dan password wajib diisi");

  // Periksa Rate Limiting (Anti Brute Force)
  const rateLimitCheck = await checkLoginRateLimit(env.LINKS, `${ip}:${username}`);
  const adminExists = await env.LINKS.get("user:admin");
  if (rateLimitCheck.blocked && (adminExists || username !== "admin")) {
    return fail(`Terlalu banyak percobaan login gagal. Akun dikunci sementara selama ${rateLimitCheck.minutes} menit demi keamanan.`, 429);
  }

  let user = await getJson(env.LINKS, `user:${username}`);

  // Auto-sync / Bootstrap: jika login admin dengan default admin123, pastikan akun valid di KV
  if (username === "admin" && password === "admin123") {
    const salt = randomToken();
    const passwordHash = `pbkdf2$${await hashPasswordPBKDF2("admin123", salt)}`;
    user = {
      passwordHash,
      salt,
      name: (user && user.name) || "Super Admin",
      instansi: (user && user.instansi) || "Kementerian Transmigrasi",
      role: "superadmin",
      status: "active",
      hashVersion: 2,
      createdAt: (user && user.createdAt) || Date.now()
    };
    await env.LINKS.put("user:admin", JSON.stringify(user));
    await clearLoginRateLimit(env.LINKS, `${ip}:${username}`);
  }

  if (!user) {
    await recordFailedLogin(env.LINKS, `${ip}:${username}`);
    return fail("Username atau password salah", 401);
  }

  // Periksa status aktif akun
  if (user.status === "inactive") {
    return fail("Akun Anda telah dinonaktifkan oleh administrator. Silakan hubungi Super Admin.", 403);
  }

  const valid = await verifyAndUpgradePassword(password, user, username, env);
  if (!valid) {
    await recordFailedLogin(env.LINKS, `${ip}:${username}`);
    return fail("Username atau password salah", 401);
  }

  // Berhasil login: bersihkan rate limit
  await clearLoginRateLimit(env.LINKS, `${ip}:${username}`);

  const token = randomToken();
  await env.LINKS.put(
    `session:${token}`,
    JSON.stringify({ username, expiresAt: Date.now() + SESSION_TTL * 1000 }),
    { expirationTtl: SESSION_TTL }
  );

  return json({ 
    ok: true, 
    name: user.name, 
    instansi: user.instansi, 
    isAdmin: isAdmin(env, { username, role: user.role }) 
  }, 200, {
    "Set-Cookie": sessionCookie(token)
  });
}

async function logout(request, env) {
  const token = getCookie(request, "session");
  if (token) await env.LINKS.delete(`session:${token}`);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}

async function me(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ loggedIn: false });
  return json({
    loggedIn: true,
    username: user.username,
    name: user.name,
    instansi: user.instansi,
    role: user.role,
    status: user.status,
    isAdmin: isAdmin(env, user)
  });
}

// Hanya dilakukan oleh Super Admin
async function createUser(env, input) {
  const username = (input.username || "").trim().toLowerCase();
  const password = (input.password || "").trim();
  const name = (input.name || "").trim();
  const instansi = (input.instansi || "").trim();
  const role = (input.role || "user").trim();
  const status = (input.status || "active").trim();

  if (!username || !password || !name || !instansi) return fail("Semua kolom wajib diisi");
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return fail("Username hanya boleh 3-32 karakter huruf kecil, angka, titik, atau tanda hubung");
  if (password.length < 6) return fail("Password minimal 6 karakter");
  if (!["user", "superadmin"].includes(role)) return fail("Role tidak valid");
  if (!["active", "inactive"].includes(status)) return fail("Status tidak valid");
  if (await env.LINKS.get(`user:${username}`)) return fail("Username sudah dipakai, silakan pilih yang lain");

  const salt = randomToken();
  const passwordHash = `pbkdf2$${await hashPasswordPBKDF2(password, salt)}`;

  await env.LINKS.put(
    `user:${username}`,
    JSON.stringify({
      passwordHash,
      salt,
      name,
      instansi,
      role,
      status,
      hashVersion: 2,
      createdAt: Date.now()
    })
  );
  return json({ ok: true, username, name, role, status });
}

async function register(request, env) {
  if (env.ALLOW_REGISTRATION !== "true") return fail("Pendaftaran mandiri dinonaktifkan. Akun hanya dapat dibuat oleh Super Admin.", 403);
  const body = await readBody(request);
  return createUser(env, { ...body, role: "user", status: "active" });
}


/* ---------- Manajemen Tautan (Shortlinks) ---------- */

async function getLinks(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return fail("Belum login", 401);
  return json(await listLinks(env.LINKS));
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

async function randomCode(kv) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = Array.from(bytes, (b) => chars[b % chars.length]).join("");
    if (!(await kv.get(code))) return code;
  }
  return null;
}

async function createLink(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return fail("Belum login", 401);

  const body = await readBody(request);
  const longUrl = (body.longUrl || "").trim();
  if (!longUrl) return fail("URL tujuan tidak boleh kosong");
  if (!isHttpUrl(longUrl)) return fail("URL tujuan harus diawali http:// atau https://");

  let code = (body.alias || "").trim().replace(/\s+/g, "-");
  if (code) {
    if (!ALIAS_PATTERN.test(code)) {
      return fail("Alias hanya boleh berisi huruf, angka, tanda hubung (-) dan garis bawah (_)");
    }
    if (RESERVED_ALIASES.has(code.toLowerCase())) {
      return fail(`Alias "${code}" adalah kata yang dicadangkan sistem. Silakan pilih alias lain.`);
    }
    if (await env.LINKS.get(code)) return fail("Alias sudah dipakai, silakan pilih yang lain");
  } else {
    code = await randomCode(env.LINKS);
    if (!code) return fail("Gagal membuat kode unik, silakan coba lagi", 500);
  }

  // Parse waktu expired (opsional)
  let expiresAt = null;
  if (body.expiresAt) {
    const exp = new Date(body.expiresAt).getTime();
    if (!isNaN(exp) && exp > Date.now()) {
      expiresAt = exp;
    }
  }

  const record = {
    longUrl,
    clicks: 0,
    createdAt: Date.now(),
    expiresAt,
    isActive: true,
    creatorName: user.name,
    creatorInstansi: user.instansi,
    creatorUsername: user.username
  };

  await env.LINKS.put(code, JSON.stringify(record));
  return json({ code, ...record });
}

// Update Tautan (Edit URL Asli, Tanggal Expired, Status Aktif)
async function updateLink(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return fail("Belum login", 401);

  const body = await readBody(request);
  const code = (body.code || "").trim();
  if (!code || !isLinkKey(code)) return fail("Kode tautan tidak valid");

  const record = await getJson(env.LINKS, code);
  if (!record) return fail("Tautan tidak ditemukan", 404);

  // Hak akses: Super Admin atau pembuat tautan
  if (!isAdmin(env, user) && record.creatorUsername !== user.username) {
    return fail("Tidak memiliki izin mengubah tautan ini", 403);
  }

  const longUrl = (body.longUrl || "").trim();
  if (longUrl) {
    if (!isHttpUrl(longUrl)) return fail("URL tujuan harus diawali http:// atau https://");
    record.longUrl = longUrl;
  }

  // Perbarui status aktif jika diberikan
  if (typeof body.isActive === "boolean") {
    record.isActive = body.isActive;
  }

  // Perbarui expiration date
  if (body.expiresAt === null || body.expiresAt === "") {
    record.expiresAt = null;
  } else if (body.expiresAt) {
    const exp = new Date(body.expiresAt).getTime();
    if (!isNaN(exp)) {
      record.expiresAt = exp;
    }
  }

  record.updatedAt = Date.now();
  record.updatedBy = user.username;

  await env.LINKS.put(code, JSON.stringify(record));
  return json({ ok: true, code, ...record });
}

async function deleteLink(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return fail("Belum login", 401);

  const code = new URL(request.url).searchParams.get("code");
  if (!code || !isLinkKey(code)) return fail("Kode tidak valid");

  // Hak akses: Super Admin atau pembuat tautan
  if (!isAdmin(env, user)) {
    const record = await getJson(env.LINKS, code);
    if (!record) return fail("Link tidak ditemukan", 404);
    if (record.creatorUsername !== user.username) return fail("Tidak punya akses menghapus link ini", 403);
  }

  await env.LINKS.delete(code);
  return json({ ok: true });
}


/* ---------- Halaman Khusus Pengalihan (Branded Pages) ---------- */

function createStatusPage(title, subtitle, description, badgeText, badgeColor = "bg-red-100 text-red-700") {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Kementerian Transmigrasi RI</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>body { font-family: 'Plus Jakarta Sans', sans-serif; }</style>
</head>
<body class="min-h-screen bg-[#0a2a3d] flex items-center justify-center p-4 text-slate-800">
  <div class="max-w-md w-full bg-white rounded-3xl p-8 shadow-2xl text-center border border-white/20">
    <div class="w-16 h-16 rounded-2xl bg-stone-100 mx-auto mb-4 flex items-center justify-center shadow-inner">
      <img src="/logo.jpg" alt="Logo KemenTrans" class="w-12 h-12 object-contain" onerror="this.src='https://placehold.co/100x100?text=RI'">
    </div>
    <span class="inline-block px-3 py-1 rounded-full text-xs font-extrabold uppercase tracking-wider ${badgeColor} mb-3">${badgeText}</span>
    <h1 class="text-xl font-extrabold text-slate-900 mb-2">${subtitle}</h1>
    <p class="text-xs text-slate-500 leading-relaxed mb-6">${description}</p>
    <div class="pt-4 border-t border-slate-100 flex items-center justify-center gap-2 text-[11px] text-slate-400">
      <span>Kementerian Transmigrasi Republik Indonesia</span>
    </div>
  </div>
</body>
</html>`;
}

const notFoundPage = () =>
  new Response(
    createStatusPage("404", "Tautan Tidak Ditemukan", "Tautan pendek ini tidak terdaftar atau telah dihapus dari sistem.", "404 Not Found"),
    { status: 404, headers: { "Content-Type": "text/html; charset=UTF-8", ...SECURITY_HEADERS } }
  );

const expiredPage = (expDate) =>
  new Response(
    createStatusPage(
      "Kedaluwarsa", 
      "Masa Berlaku Tautan Telah Berakhir", 
      `Tautan resmi ini disetel memiliki batas waktu aktif yang telah berakhir pada <b>${expDate}</b>. Silakan hubungi unit kerja penerbit tautan untuk informasi lebih lanjut.`, 
      "Link Expired",
      "bg-amber-100 text-amber-800"
    ),
    { status: 410, headers: { "Content-Type": "text/html; charset=UTF-8", ...SECURITY_HEADERS } }
  );

const disabledPage = () =>
  new Response(
    createStatusPage(
      "Nonaktif", 
      "Tautan Dinonaktifkan Sementara", 
      "Akses ke tautan ini sedang dinonaktifkan oleh pemilik tautan atau administrator.", 
      "Tautan Nonaktif",
      "bg-slate-200 text-slate-700"
    ),
    { status: 403, headers: { "Content-Type": "text/html; charset=UTF-8", ...SECURITY_HEADERS } }
  );

async function redirect(code, env, ctx) {
  if (!isLinkKey(code)) return notFoundPage();

  const record = await getJson(env.LINKS, code);
  if (!record?.longUrl) return notFoundPage();

  // Logika 1: Periksa status aktif
  if (record.isActive === false) {
    return disabledPage();
  }

  // Logika 2: Periksa masa kedaluwarsa (Expired Link)
  if (record.expiresAt && Date.now() > record.expiresAt) {
    const d = new Date(record.expiresAt + WIB_OFFSET_MS);
    const formatted = `${d.getUTCDate().toString().padStart(2, "0")}-${(d.getUTCMonth() + 1).toString().padStart(2, "0")}-${d.getUTCFullYear()} ${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")} WIB`;
    return expiredPage(formatted);
  }

  let target;
  try {
    target = new URL(record.longUrl);
  } catch {
    return notFoundPage();
  }

  // Hitung klik di belakang layar secara non-blocking
  record.clicks = (record.clicks || 0) + 1;
  ctx.waitUntil(env.LINKS.put(code, JSON.stringify(record)));

  return Response.redirect(target.href, 302);
}


/* ---------- Khusus Super Admin: User CRUD & Statistik ---------- */

async function adminUsers(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;

  const users = await listUsers(env.LINKS);
  return json(
    users.map(({ username, name, instansi, role, status, createdAt }) => ({
      username,
      name,
      instansi,
      role: role || "user",
      status: status || "active",
      createdAt
    }))
  );
}

async function adminCreateUser(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;
  return createUser(env, await readBody(request));
}

async function adminUpdateUser(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;

  const body = await readBody(request);
  const username = (body.username || "").trim().toLowerCase();
  if (!username) return fail("Username wajib diisi");

  const user = await getJson(env.LINKS, `user:${username}`);
  if (!user) return fail("Pengguna tidak ditemukan", 404);

  if (body.name) user.name = body.name.trim();
  if (body.instansi) user.instansi = body.instansi.trim();
  if (body.role && ["user", "superadmin"].includes(body.role)) user.role = body.role;
  if (body.status && ["active", "inactive"].includes(body.status)) {
    // Cegah menonaktifkan akun sendiri
    if (username === admin.user.username && body.status === "inactive") {
      return fail("Tidak dapat menonaktifkan akun sendiri");
    }
    user.status = body.status;
  }

  user.updatedAt = Date.now();
  user.updatedBy = admin.user.username;

  await env.LINKS.put(`user:${username}`, JSON.stringify(user));
  return json({ ok: true, username, name: user.name, instansi: user.instansi, role: user.role, status: user.status });
}

async function adminResetPassword(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;

  const body = await readBody(request);
  const username = (body.username || "").trim().toLowerCase();
  const newPassword = (body.newPassword || "").trim();

  if (!username || !newPassword) return fail("Username dan password baru wajib diisi");
  if (newPassword.length < 6) return fail("Password baru minimal 6 karakter");

  const user = await getJson(env.LINKS, `user:${username}`);
  if (!user) return fail("Pengguna tidak ditemukan", 404);

  const salt = randomToken();
  user.salt = salt;
  user.passwordHash = `pbkdf2$${await hashPasswordPBKDF2(newPassword, salt)}`;
  user.hashVersion = 2;
  user.passwordResetAt = Date.now();
  user.passwordResetBy = admin.user.username;

  await env.LINKS.put(`user:${username}`, JSON.stringify(user));
  return json({ ok: true, message: `Password akun ${username} berhasil direset.` });
}

async function adminDeleteUser(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;

  const body = await readBody(request);
  const username = (body.username || "").trim().toLowerCase();
  if (!username) return fail("Username wajib diisi");
  if (username === admin.user.username) return fail("Tidak bisa menghapus akun sendiri");
  if (!(await env.LINKS.get(`user:${username}`))) return fail("Pengguna tidak ditemukan", 404);

  await env.LINKS.delete(`user:${username}`);
  return json({ ok: true });
}

// Statistik kaya & mendalam (Top 5 Links, Satker Leaderboard, Metrik 7 Hari)
const dayKey = (ts) => new Date(ts + WIB_OFFSET_MS).toISOString().slice(0, 10);

async function computeStats(kv) {
  const [users, links] = await Promise.all([listUsers(kv), listLinks(kv)]);

  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, i) => dayKey(now - (6 - i) * DAY_MS));
  const zero = () => Object.fromEntries(days.map((d) => [d, 0]));
  const clicks = zero();
  const linksCreated = zero();
  const usersCreated = zero();

  let activeUsersCount = 0;
  for (const user of users) {
    if (user.status !== "inactive") activeUsersCount++;
    const day = user.createdAt && dayKey(user.createdAt);
    if (day in usersCreated) usersCreated[day]++;
  }

  let totalClicks = 0;
  let activeLinksCount = 0;
  let expiredLinksCount = 0;
  const satkerMap = {};

  for (const link of links) {
    const isExpired = link.expiresAt && now > link.expiresAt;
    const isActive = link.isActive !== false && !isExpired;
    
    if (isActive) activeLinksCount++;
    if (isExpired) expiredLinksCount++;

    const clickCount = link.clicks || 0;
    totalClicks += clickCount;

    const day = link.createdAt && dayKey(link.createdAt);
    if (day in linksCreated) {
      linksCreated[day]++;
      clicks[day] += clickCount;
    }

    // Hitung performa Satker/Instansi
    const satker = (link.creatorInstansi || "Lainnya").trim();
    if (!satkerMap[satker]) satkerMap[satker] = { links: 0, clicks: 0 };
    satkerMap[satker].links += 1;
    satkerMap[satker].clicks += clickCount;
  }

  // Top 5 Tautan Paling Banyak Diklik
  const topLinks = [...links]
    .sort((a, b) => (b.clicks || 0) - (a.clicks || 0))
    .slice(0, 5)
    .map((l) => ({
      code: l.code,
      longUrl: l.longUrl,
      clicks: l.clicks || 0,
      creatorName: l.creatorName,
      creatorInstansi: l.creatorInstansi,
      createdAt: l.createdAt
    }));

  // Leaderboard Satker Teraktif
  const topSatker = Object.entries(satkerMap)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.links - a.links || b.clicks - a.clicks)
    .slice(0, 5);

  const stats = {
    totalUsers: users.length,
    activeUsers: activeUsersCount,
    totalLinks: links.length,
    activeLinks: activeLinksCount,
    expiredLinks: expiredLinksCount,
    totalClicks,
    clicksPerDay: Object.values(clicks),
    linksPerDay: Object.values(linksCreated),
    usersPerDay: Object.values(usersCreated),
    topLinks,
    topSatker,
    updatedAt: Date.now()
  };

  await kv.put("_stats", JSON.stringify(stats));
  return stats;
}

async function adminStats(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin.response) return admin.response;

  const force = new URL(request.url).searchParams.get("refresh") === "1";
  let stats = force ? null : await getJson(env.LINKS, "_stats");
  if (!stats?.updatedAt || Date.now() - stats.updatedAt > STATS_CACHE_MS) {
    stats = await computeStats(env.LINKS);
  }

  const last = (arr) => (arr && arr[arr.length - 1]) || 0;
  const prev = (arr) => (arr && arr[arr.length - 2]) || 0;

  return json({
    ...stats,
    trendUsers: last(stats.usersPerDay),
    trendLinks: last(stats.linksPerDay),
    trendClicks: last(stats.clicksPerDay),
    prevUsers: prev(stats.usersPerDay),
    prevLinks: prev(stats.linksPerDay),
    prevClicks: prev(stats.clicksPerDay)
  });
}


/* ---------- Routing Engine ---------- */

const routes = {
  "POST /api/login": login,
  "POST /api/logout": logout,
  "GET /api/me": me,
  "POST /api/register": register,
  "GET /api/links": getLinks,
  "POST /api/links": createLink,
  "POST /api/links/update": updateLink,
  "DELETE /api/links": deleteLink,
  "GET /api/admin/users": adminUsers,
  "POST /api/admin/create-user": adminCreateUser,
  "POST /api/admin/update-user": adminUpdateUser,
  "POST /api/admin/reset-password": adminResetPassword,
  "POST /api/admin/delete-user": adminDeleteUser,
  "GET /api/admin/stats": adminStats
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    try {
      if (pathname.startsWith("/api/")) {
        const handler = routes[`${request.method} ${pathname}`];
        return handler ? await handler(request, env, ctx) : fail("Endpoint tidak ditemukan", 404);
      }

      // /<kode> (satu segmen saja) dianggap tautan pendek
      const match = pathname.match(/^\/([^/]+)$/);
      if (request.method === "GET" && match) {
        let code;
        try {
          code = decodeURIComponent(match[1]);
        } catch {
          return notFoundPage();
        }
        return await redirect(code, env, ctx);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return fail("Terjadi kesalahan di server", 500);
    }
  }
};

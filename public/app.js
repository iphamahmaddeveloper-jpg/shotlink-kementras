// Logika Frontend Shorten Link Transmigrasi v2.0
// Portal Resmi Internal Kementerian Transmigrasi Republik Indonesia

let allLinks = [];
let allUsers = [];
let currentUser = null;
let statsLoaded = false;
let currentQrCodeInstance = null;
let currentQrUrl = '';
let currentQrCodeName = '';

const $ = (id) => document.getElementById(id);

// ---------- Helper Sanitasi & API ----------

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { /* respons bukan JSON */ }
    return { ok: res.ok, status: res.status, data };
}

const shortUrlOf = (code) => `${window.location.origin}/${code}`;

function showToast(message, isError = false) {
    const toast = $('toast');
    $('toast-message').textContent = message;
    $('toast-icon').innerHTML = isError
        ? '<i class="fa-solid fa-circle-exclamation text-red-400"></i>'
        : '<i class="fa-solid fa-circle-check text-teal-400"></i>';

    toast.classList.remove('opacity-0', 'translate-y-20', 'pointer-events-none');
    toast.classList.add('opacity-100', 'translate-y-0');
    setTimeout(() => {
        toast.classList.remove('opacity-100', 'translate-y-0');
        toast.classList.add('opacity-0', 'translate-y-20', 'pointer-events-none');
    }, 2400);
}

function copyText(text, successMsg = 'Tautan berhasil disalin!') {
    navigator.clipboard.writeText(text).then(() => showToast(successMsg)).catch(() => {
        // Fallback jika clipboard API terhalang
        const input = document.createElement('input');
        input.value = text;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
        showToast(successMsg);
    });
}

function formatDate(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatDateOnly(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
}

// ---------- Autentikasi & Sesi ----------

async function checkAuth() {
    try {
        const { data } = await api('/api/me');
        if (data?.loggedIn) {
            currentUser = data;
            showMainApp();
        } else {
            showAuthScreen();
        }
    } catch {
        showAuthScreen();
    }
}

function showMainApp() {
    $('auth-screen').classList.add('hidden');
    $('main-app').classList.remove('hidden');
    $('user-display-name').textContent = currentUser.name || currentUser.username;
    $('user-display-instansi').textContent = currentUser.instansi ? `(${currentUser.instansi})` : '';

    const admin = currentUser.isAdmin;
    $('admin-badge').classList.toggle('hidden', !admin);
    $('admin-tabs-section').classList.toggle('hidden', !admin);
    
    if (!admin) {
        $('panel-users').classList.add('hidden');
        $('panel-stats').classList.add('hidden');
        $('panel-links').classList.remove('hidden');
    }

    loadLinks();
    if (admin) {
        loadUsers();
        loadStats();
    }
}

function showAuthScreen() {
    $('main-app').classList.add('hidden');
    $('auth-screen').classList.remove('hidden');
}

function togglePasswordVisibility(inputId, iconId) {
    const input = $(inputId);
    const icon = $(iconId);
    if (!input || !icon) return;
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
        $('login-pwd-text').textContent = 'Sembunyikan';
    } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
        $('login-pwd-text').textContent = 'Lihat';
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const errorEl = $('login-error');
    const btn = $('login-btn');
    errorEl.classList.add('hidden');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin text-sm"></i> <span>Memproses...</span>';

    try {
        const { ok, data } = await api('/api/login', {
            method: 'POST',
            body: {
                username: $('login-username').value.trim(),
                password: $('login-password').value
            }
        });
        if (!ok) {
            errorEl.textContent = data?.error || 'Gagal masuk. Periksa kembali username dan password.';
            errorEl.classList.remove('hidden');
            btn.disabled = false;
            btn.innerHTML = '<span>Masuk</span> <i class="fa-solid fa-arrow-right text-xs"></i>';
            return;
        }
        // Langsung set currentUser dari response login tanpa round-trip ke /api/me
        currentUser = {
            loggedIn: true,
            username: $('login-username').value.trim().toLowerCase(),
            name: data.name || $('login-username').value.trim(),
            instansi: data.instansi || '',
            role: data.isAdmin ? 'superadmin' : 'user',
            isAdmin: !!data.isAdmin
        };
        showMainApp();
        showToast('Berhasil masuk ke portal!');
    } catch {
        errorEl.textContent = 'Terjadi gangguan koneksi ke server.';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>Masuk</span> <i class="fa-solid fa-arrow-right text-xs"></i>';
    }
}


async function handleLogout() {
    await api('/api/logout', { method: 'POST' });
    currentUser = null;
    showAuthScreen();
}

function switchTab(tab) {
    ['links', 'users', 'stats'].forEach((name) => {
        const tabBtn = $(`tab-${name}`);
        const panel = $(`panel-${name}`);
        if (tabBtn) tabBtn.classList.toggle('active', name === tab);
        if (panel) panel.classList.toggle('hidden', name !== tab);
    });

    if (tab === 'stats') {
        loadStats(!statsLoaded);
        statsLoaded = true;
    }
    if (tab === 'users') loadUsers();
    if (tab === 'links') loadLinks();
}


// ---------- Modul 1: Manajemen Tautan (Shortlinks) ----------

async function loadLinks() {
    try {
        const { ok, status, data } = await api('/api/links');
        if (status === 401) return showAuthScreen();
        if (!ok || !Array.isArray(data)) throw new Error('Format data tidak valid');
        allLinks = data;
        populateSatkerFilter();
        renderLinks();
    } catch {
        $('links-list-body').innerHTML =
            '<tr><td colspan="5" class="py-8 text-center text-red-400">Gagal memuat daftar tautan.</td></tr>';
    }
}

function populateSatkerFilter() {
    const select = $('filter-links-satker');
    if (!select) return;
    const currentVal = select.value;
    const satkerSet = new Set();
    allLinks.forEach((l) => {
        if (l.creatorInstansi) satkerSet.add(l.creatorInstansi.trim());
    });
    
    let html = '<option value="">Semua Satker/Instansi</option>';
    Array.from(satkerSet).sort().forEach((satker) => {
        html += `<option value="${esc(satker)}">${esc(satker)}</option>`;
    });
    select.innerHTML = html;
    if (currentVal) select.value = currentVal;
}

// ---------- Logika Preset Masa Berlaku (Kedaluwarsa Pintar) ----------

function onExpiryPresetChange(selectId, wrapId) {
    const select = $(selectId);
    const wrap = $(wrapId);
    if (!select || !wrap) return;
    wrap.classList.toggle('hidden', select.value !== 'custom');
}

function calculateExpiryTimestamp(presetVal, customInputVal) {
    const now = Date.now();
    if (presetVal === '7d') return new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    if (presetVal === '30d') return new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    if (presetVal === '90d') return new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString();
    if (presetVal === '1y') return new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString();
    if (presetVal === 'custom' && customInputVal) {
        const d = new Date(customInputVal).getTime();
        return !isNaN(d) ? new Date(d).toISOString() : null;
    }
    return null; // 'never'
}

async function handleShorten(e) {
    e.preventDefault();
    const btn = $('btn-shorten');
    const longUrl = $('long-url').value.trim();
    const alias = $('custom-alias').value.trim();
    const presetVal = $('link-expires-preset').value;
    const customVal = $('link-expires-custom').value;
    const expiresAt = calculateExpiryTimestamp(presetVal, customVal);

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin text-xs"></i> <span>Menyimpan...</span>';

    try {
        const { ok, data } = await api('/api/links', { 
            method: 'POST', 
            body: { longUrl, alias, expiresAt } 
        });
        if (!ok) return showToast(data?.error || 'Gagal membuat tautan', true);

        $('long-url').value = '';
        $('custom-alias').value = '';
        $('link-expires-preset').value = 'never';
        $('link-expires-custom').value = '';
        $('link-expires-custom-wrap').classList.add('hidden');

        allLinks.unshift(data);
        populateSatkerFilter();
        renderLinks();
        showToast('Tautan resmi berhasil dibuat!');
    } catch {
        showToast('Terjadi kesalahan jaringan', true);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt text-xs text-[#d4af5a]"></i> <span>Perpendek URL</span>';
    }
}

const ACTION_BTN = 'p-1.5 sm:p-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 shadow-2xs transition';

function linkRowHtml(link) {
    const code = esc(link.code);
    const creator = esc(link.creatorName || '-');
    const instansi = esc(link.creatorInstansi || '-');
    const longUrl = esc(link.longUrl || '-');
    const canManage = currentUser.isAdmin || link.creatorUsername === currentUser.username;
    const now = Date.now();

    // Logika Status Visual
    const isExpired = link.expiresAt && now > link.expiresAt;
    const isDisabled = link.isActive === false;

    let statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Aktif</span>';
    if (isDisabled) {
        statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600"><span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span> Nonaktif</span>';
    } else if (isExpired) {
        statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800"><span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span> Kedaluwarsa</span>';
    }

    const expiryInfo = link.expiresAt 
        ? `<div class="text-[10px] text-slate-400 mt-0.5"><i class="fa-regular fa-clock text-[9px] mr-1"></i>s/d ${formatDate(link.expiresAt)}</div>`
        : '<div class="text-[10px] text-slate-400 mt-0.5">Selamanya</div>';

    const editBtn = canManage
        ? `<button data-action="edit" data-code="${code}" class="${ACTION_BTN} hover:text-teal-700" title="Edit Tautan"><i class="fa-regular fa-pen-to-square text-xs"></i></button>`
        : '';

    const deleteBtn = canManage
        ? `<button data-action="delete" data-code="${code}" class="${ACTION_BTN} hover:text-red-600 hover:border-red-200" title="Hapus Tautan"><i class="fa-regular fa-trash-can text-xs"></i></button>`
        : '';

    return `<tr class="hover:bg-slate-50/80 transition duration-150">
        <td class="py-3.5 px-4 sm:px-6 min-w-[200px]">
            <div class="flex items-center gap-2">
                <button data-action="open" data-code="${code}" class="text-left text-teal-700 hover:text-teal-900 hover:underline font-extrabold text-xs tracking-tight">${esc(shortUrlOf(link.code))}</button>
            </div>
            <div class="text-slate-400 text-[11px] truncate max-w-xs sm:max-w-sm mt-0.5 font-normal" title="${longUrl}">
                <i class="fa-solid fa-arrow-turn-down-right text-[9px] mr-1 text-slate-300"></i>${longUrl}
            </div>
        </td>
        <td class="py-3.5 px-4 sm:px-6">
            <div class="font-bold text-slate-800 text-xs">${creator}</div>
            <div class="text-slate-400 text-[11px] font-medium">${instansi}</div>
        </td>
        <td class="py-3.5 px-4 sm:px-6 text-center">
            ${statusBadge}
            ${expiryInfo}
        </td>
        <td class="py-3.5 px-4 sm:px-6 text-center">
            <span class="inline-flex items-center justify-center px-2.5 py-1 rounded-xl bg-slate-100 text-slate-800 font-mono font-bold text-xs shadow-2xs">${link.clicks || 0}</span>
        </td>
        <td class="py-3.5 px-4 sm:px-6 text-right">
            <div class="inline-flex items-center gap-1 sm:gap-1.5">
                <button data-action="copy" data-code="${code}" class="${ACTION_BTN} hover:text-teal-700" title="Salin Tautan"><i class="fa-regular fa-copy text-xs"></i></button>
                <button data-action="qr" data-code="${code}" class="${ACTION_BTN} hover:text-teal-700" title="QR Code Resmi"><i class="fa-solid fa-qrcode text-xs"></i></button>
                ${editBtn}
                ${deleteBtn}
            </div>
        </td>
    </tr>`;
}

function renderLinks() {
    const tbody = $('links-list-body');
    const query = ($('search-links').value || '').toLowerCase().trim();
    const satkerFilter = ($('filter-links-satker')?.value || '').toLowerCase();
    const statusFilter = $('filter-links-status')?.value || 'all';
    const now = Date.now();

    const filtered = allLinks.filter((link) => {
        const matchQuery = !query || 
            link.code.toLowerCase().includes(query) ||
            (link.longUrl || '').toLowerCase().includes(query) ||
            (link.creatorName || '').toLowerCase().includes(query) ||
            (link.creatorInstansi || '').toLowerCase().includes(query);

        const matchSatker = !satkerFilter || (link.creatorInstansi || '').toLowerCase() === satkerFilter;

        const isExpired = link.expiresAt && now > link.expiresAt;
        const isDisabled = link.isActive === false;
        let matchStatus = true;
        if (statusFilter === 'active') matchStatus = !isDisabled && !isExpired;
        if (statusFilter === 'expired') matchStatus = isExpired;
        if (statusFilter === 'inactive') matchStatus = isDisabled;

        return matchQuery && matchSatker && matchStatus;
    });

    $('links-count-badge').textContent = filtered.length;

    tbody.innerHTML = filtered.length
        ? filtered.map(linkRowHtml).join('')
        : '<tr><td colspan="5" class="py-10 text-center text-slate-400">Tidak ada tautan yang sesuai filter.</td></tr>';
}

function onLinkTableClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const { action, code } = btn.dataset;
    if (action === 'open') openRedirectModal(code);
    if (action === 'copy') copyText(shortUrlOf(code));
    if (action === 'qr') openQrModal(code);
    if (action === 'edit') openEditLinkModal(code);
    if (action === 'delete') deleteLink(code);
}

// Modal Edit Link
function openEditLinkModal(code) {
    const link = allLinks.find((l) => l.code === code);
    if (!link) return;

    $('edit-link-code').value = link.code;
    $('edit-link-code-display').value = shortUrlOf(link.code);
    $('edit-link-long-url').value = link.longUrl;
    $('edit-link-is-active').value = link.isActive === false ? 'false' : 'true';

    if (link.expiresAt) {
        $('edit-link-expires-preset').value = 'custom';
        $('edit-link-expires-custom-wrap').classList.remove('hidden');
        const localIso = new Date(link.expiresAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        $('edit-link-expires-custom').value = localIso;
    } else {
        $('edit-link-expires-preset').value = 'never';
        $('edit-link-expires-custom-wrap').classList.add('hidden');
        $('edit-link-expires-custom').value = '';
    }

    $('edit-link-modal').classList.remove('hidden');
}

function closeEditLinkModal() {
    $('edit-link-modal').classList.add('hidden');
}

async function handleSaveEditLink(e) {
    e.preventDefault();
    const code = $('edit-link-code').value;
    const longUrl = $('edit-link-long-url').value.trim();
    const isActive = $('edit-link-is-active').value === 'true';
    const presetVal = $('edit-link-expires-preset').value;
    const customVal = $('edit-link-expires-custom').value;
    const expiresAt = calculateExpiryTimestamp(presetVal, customVal);

    try {
        const { ok, data } = await api('/api/links/update', {
            method: 'POST',
            body: { code, longUrl, isActive, expiresAt }
        });

        if (!ok) return showToast(data?.error || 'Gagal memperbarui tautan', true);

        // Update lokal
        const idx = allLinks.findIndex((l) => l.code === code);
        if (idx > -1) {
            allLinks[idx] = { 
                ...allLinks[idx], 
                longUrl, 
                isActive, 
                expiresAt: expiresAt ? new Date(expiresAt).getTime() : null 
            };
        }

        renderLinks();
        closeEditLinkModal();
        showToast('Tautan berhasil diperbarui!');
    } catch {
        showToast('Terjadi kesalahan jaringan', true);
    }
}

// Modal QR Code
let currentLinkObj = null;

function openQrModal(code) {
    const link = allLinks.find((l) => l.code === code);
    if (!link) return;

    currentLinkObj = link;
    const fullUrl = shortUrlOf(code);
    currentQrUrl = fullUrl;
    currentQrCodeName = code;

    $('qr-modal-title').textContent = `/${code}`;
    $('qr-modal-url').textContent = fullUrl;
    $('qr-modal-creator').textContent = `Diterbitkan oleh: ${link.creatorName || '-'} (${link.creatorInstansi || 'KemenTrans'})`;

    const container = $('qrcode-target');
    container.innerHTML = '';

    if (window.QRCode) {
        currentQrCodeInstance = new QRCode(container, {
            text: fullUrl,
            width: 190,
            height: 190,
            colorDark: "#0a2a3d",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.H
        });
    }

    $('qr-modal').classList.remove('hidden');
}

function closeQrModal() {
    $('qr-modal').classList.add('hidden');
}

// Unduh Kartu Gambar QR Resmi Lengkap (High-DPI Branded Card)
function downloadBrandedQrCard() {
    if (!currentLinkObj) return;

    const qrCanvas = $('qrcode-target').querySelector('canvas');
    if (!qrCanvas) return showToast('QR Code sedang disiapkan...', true);

    const cardWidth = 800;
    const cardHeight = 1060;
    const canvas = document.createElement('canvas');
    canvas.width = cardWidth;
    canvas.height = cardHeight;
    const ctx = canvas.getContext('2d');

    // 1. Background Card
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, cardWidth, cardHeight);

    // 2. Header Background (Deep Navy to Teal Gradient)
    const headerGrad = ctx.createLinearGradient(0, 0, cardWidth, 180);
    headerGrad.addColorStop(0, '#0a2a3d');
    headerGrad.addColorStop(0.6, '#0d3b4f');
    headerGrad.addColorStop(1, '#0a4a5c');
    ctx.fillStyle = headerGrad;
    ctx.fillRect(0, 0, cardWidth, 200);

    // 3. Header Text & Logo
    const logoImg = new Image();
    logoImg.crossOrigin = 'anonymous';
    logoImg.src = 'logo.jpg';

    const renderCardContent = () => {
        // Draw Logo Box
        try {
            if (logoImg.complete && logoImg.naturalHeight !== 0) {
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.roundRect(40, 45, 110, 110, 20);
                ctx.fill();
                ctx.drawImage(logoImg, 50, 55, 90, 90);
            }
        } catch (e) { /* ignore */ }

        // Ministry Title
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 30px Plus Jakarta Sans, sans-serif';
        ctx.fillText('KEMENTERIAN TRANSMIGRASI', 175, 95);

        ctx.fillStyle = '#d4af5a';
        ctx.font = '700 18px Plus Jakarta Sans, sans-serif';
        ctx.fillText('REPUBLIK INDONESIA', 175, 125);

        // Gold Accent Line
        ctx.fillStyle = '#d4af5a';
        ctx.fillRect(0, 196, cardWidth, 6);

        // 4. White Center Box for QR Code
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(10, 42, 61, 0.12)';
        ctx.shadowBlur = 24;
        ctx.shadowOffsetY = 10;
        ctx.beginPath();
        ctx.roundRect(140, 260, 520, 520, 32);
        ctx.fill();
        ctx.shadowColor = 'transparent';

        // 5. Draw QR Code in Center Box
        ctx.drawImage(qrCanvas, 185, 305, 430, 430);

        // 6. Shortlink URL Pill Badge
        ctx.fillStyle = '#f0fdfa';
        ctx.strokeStyle = '#0d9488';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(100, 815, 600, 70, 20);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#0f766e';
        ctx.font = '800 24px Plus Jakarta Sans, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(currentQrUrl, 400, 858);

        // 7. Satker / Creator Information
        ctx.fillStyle = '#334155';
        ctx.font = '700 20px Plus Jakarta Sans, sans-serif';
        const satkerText = `${currentLinkObj.creatorInstansi || 'Kementerian Transmigrasi'}`;
        ctx.fillText(satkerText, 400, 930);

        ctx.fillStyle = '#64748b';
        ctx.font = '500 16px Plus Jakarta Sans, sans-serif';
        ctx.fillText(`Dibuat oleh: ${currentLinkObj.creatorName || '-'}`, 400, 960);

        // 8. Footer Security Note
        ctx.fillStyle = '#94a3b8';
        ctx.font = '600 14px Plus Jakarta Sans, sans-serif';
        ctx.fillText('Pindai QR Code untuk Mengakses Informasi Resmi Terverifikasi', 400, 1015);

        // Trigger Download
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = `Kartu-QR-KemenTrans-${currentQrCodeName}.png`;
        a.click();
        showToast('Kartu Gambar QR Resmi berhasil diunduh!');
    };

    if (logoImg.complete) {
        renderCardContent();
    } else {
        logoImg.onload = renderCardContent;
        logoImg.onerror = renderCardContent;
    }
}

function downloadQrCode() {
    const canvas = $('qrcode-target').querySelector('canvas');
    if (!canvas) {
        const img = $('qrcode-target').querySelector('img');
        if (img && img.src) {
            const a = document.createElement('a');
            a.href = img.src;
            a.download = `QR-Polos-${currentQrCodeName}.png`;
            a.click();
            showToast('QR Code polos berhasil diunduh!');
        }
        return;
    }
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `QR-Polos-${currentQrCodeName}.png`;
    a.click();
    showToast('QR Code polos berhasil diunduh!');
}

function copyQrLink() {
    copyText(currentQrUrl, 'URL tautan disalin ke clipboard!');
}

// Ekspor CSV
function exportLinksToCsv() {
    if (!allLinks.length) return showToast('Tidak ada data untuk diekspor', true);

    const headers = ['Kode Shortlink', 'Tautan Asli', 'Pembuat', 'Satker/Instansi', 'Status', 'Batas Kedaluwarsa', 'Jumlah Klik', 'Tanggal Dibuat'];
    const now = Date.now();

    const rows = allLinks.map((l) => {
        const isExpired = l.expiresAt && now > l.expiresAt;
        const status = l.isActive === false ? 'Nonaktif' : (isExpired ? 'Kedaluwarsa' : 'Aktif');
        return [
            shortUrlOf(l.code),
            `"${(l.longUrl || '').replace(/"/g, '""')}"`,
            `"${(l.creatorName || '').replace(/"/g, '""')}"`,
            `"${(l.creatorInstansi || '').replace(/"/g, '""')}"`,
            status,
            l.expiresAt ? formatDate(l.expiresAt) : 'Selamanya',
            l.clicks || 0,
            formatDate(l.createdAt)
        ].join(',');
    });

    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Rekap-Shortlink-KemenTrans-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Data berhasil diekspor ke file CSV!');
}

function openRedirectModal(code) {
    const target = allLinks.find((link) => link.code === code);
    if (!target) return;

    $('redirect-short-display').textContent = shortUrlOf(code);
    $('redirect-url-display').textContent = target.longUrl;
    $('redirect-confirm-btn').href = `/${encodeURIComponent(code)}`;
    $('redirect-modal').classList.remove('hidden');
}

function closeRedirectModal() {
    $('redirect-modal').classList.add('hidden');
    setTimeout(loadLinks, 600);
}

async function deleteLink(code) {
    if (!confirm(`Hapus tautan pendek "/${code}"? Tautan ini tidak akan bisa diakses lagi.`)) return;

    try {
        const { ok, data } = await api(`/api/links?code=${encodeURIComponent(code)}`, { method: 'DELETE' });
        if (!ok) return showToast(data?.error || 'Gagal menghapus tautan', true);

        allLinks = allLinks.filter((link) => link.code !== code);
        renderLinks();
        showToast('Tautan berhasil dihapus.');
    } catch {
        showToast('Gagal menghapus tautan', true);
    }
}


// ---------- Modul 2: Manajemen Pengguna (Khusus Super Admin) ----------

async function loadUsers() {
    try {
        const { ok, data } = await api('/api/admin/users');
        if (!ok || !Array.isArray(data)) return;
        allUsers = data;
        renderUsers();
    } catch { /* biarkan tabel */ }
}

function userRowHtml(user) {
    const isSuperAdmin = user.role === 'superadmin';
    const isSelf = user.username === currentUser.username;
    const isInactive = user.status === 'inactive';
    const username = esc(user.username);

    const roleBadge = isSuperAdmin 
        ? '<span class="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-[#d4af5a]/20 text-[#0a2a3d] border border-[#d4af5a]/40">Super Admin</span>' 
        : '<span class="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700">User</span>';

    const statusBadge = isInactive
        ? '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700"><span class="w-1.5 h-1.5 rounded-full bg-red-500"></span> Nonaktif</span>'
        : '<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Aktif</span>';

    const action = isSelf
        ? '<span class="text-[10px] text-slate-400 italic">Akun Anda Sendiri</span>'
        : `<div class="inline-flex items-center gap-1">
            <button data-action="edit-user" data-username="${username}" class="${ACTION_BTN} hover:text-teal-700" title="Edit Data Pengguna"><i class="fa-regular fa-pen-to-square text-xs"></i></button>
            <button data-action="reset-pwd" data-username="${username}" class="${ACTION_BTN} hover:text-amber-600" title="Reset Password"><i class="fa-solid fa-key text-xs"></i></button>
            <button data-action="toggle-status" data-username="${username}" data-status="${user.status || 'active'}" class="${ACTION_BTN} ${isInactive ? 'hover:text-emerald-600' : 'hover:text-amber-600'}" title="${isInactive ? 'Aktifkan Akun' : 'Nonaktifkan Akun'}"><i class="fa-solid ${isInactive ? 'fa-user-check' : 'fa-user-slash'} text-xs"></i></button>
            <button data-action="delete-user" data-username="${username}" class="${ACTION_BTN} hover:text-red-600 hover:border-red-200" title="Hapus Pengguna"><i class="fa-regular fa-trash-can text-xs"></i></button>
          </div>`;

    return `<tr class="hover:bg-slate-50/80 transition duration-150">
        <td class="py-3.5 px-4 sm:px-6">
            <div class="font-extrabold text-slate-900 text-xs">${username}</div>
            <div class="text-slate-400 text-[10px]">Dibuat: ${formatDateOnly(user.createdAt)}</div>
        </td>
        <td class="py-3.5 px-4 sm:px-6 font-semibold text-slate-800 text-xs">${esc(user.name || '-')}</td>
        <td class="py-3.5 px-4 sm:px-6 text-slate-600 text-xs">${esc(user.instansi || '-')}</td>
        <td class="py-3.5 px-4 sm:px-6 text-center">${roleBadge}</td>
        <td class="py-3.5 px-4 sm:px-6 text-center">${statusBadge}</td>
        <td class="py-3.5 px-4 sm:px-6 text-right">${action}</td>
    </tr>`;
}

function renderUsers() {
    const tbody = $('users-list-body');
    const query = ($('search-users')?.value || '').toLowerCase().trim();

    const filtered = allUsers.filter((u) => 
        !query ||
        u.username.toLowerCase().includes(query) ||
        (u.name || '').toLowerCase().includes(query) ||
        (u.instansi || '').toLowerCase().includes(query)
    );

    tbody.innerHTML = filtered.length
        ? filtered.map(userRowHtml).join('')
        : '<tr><td colspan="6" class="py-10 text-center text-slate-400">Tidak ada pengguna ditemukan.</td></tr>';
}

function onUserTableClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const { action, username, status } = btn.dataset;
    if (action === 'edit-user') openEditUserModal(username);
    if (action === 'reset-pwd') openResetPasswordModal(username);
    if (action === 'toggle-status') toggleUserStatus(username, status);
    if (action === 'delete-user') deleteUser(username);
}

// Modal Create User
function openCreateUserModal() {
    $('cu-username').value = '';
    $('cu-password').value = '';
    $('cu-name').value = '';
    $('cu-instansi').value = '';
    $('cu-role').value = 'user';
    $('cu-status').value = 'active';
    $('create-user-modal').classList.remove('hidden');
}

function closeCreateUserModal() {
    $('create-user-modal').classList.add('hidden');
}

async function handleCreateUser(e) {
    e.preventDefault();
    const body = {
        username: $('cu-username').value.trim(),
        password: $('cu-password').value,
        name: $('cu-name').value.trim(),
        instansi: $('cu-instansi').value.trim(),
        role: $('cu-role').value,
        status: $('cu-status').value
    };

    try {
        const { ok, data } = await api('/api/admin/create-user', { method: 'POST', body });
        if (!ok) return showToast(data?.error || 'Gagal membuat akun', true);

        closeCreateUserModal();
        loadUsers();
        showToast(`Akun ${body.username} berhasil dibuat!`);
    } catch {
        showToast('Terjadi kesalahan jaringan', true);
    }
}

// Modal Edit User
function openEditUserModal(username) {
    const user = allUsers.find((u) => u.username === username);
    if (!user) return;

    $('eu-username').value = user.username;
    $('eu-username-display').value = user.username;
    $('eu-name').value = user.name || '';
    $('eu-instansi').value = user.instansi || '';
    $('eu-role').value = user.role || 'user';
    $('eu-status').value = user.status || 'active';

    $('edit-user-modal').classList.remove('hidden');
}

function closeEditUserModal() {
    $('edit-user-modal').classList.add('hidden');
}

async function handleSaveEditUser(e) {
    e.preventDefault();
    const username = $('eu-username').value;
    const body = {
        username,
        name: $('eu-name').value.trim(),
        instansi: $('eu-instansi').value.trim(),
        role: $('eu-role').value,
        status: $('eu-status').value
    };

    try {
        const { ok, data } = await api('/api/admin/update-user', { method: 'POST', body });
        if (!ok) return showToast(data?.error || 'Gagal memperbarui pengguna', true);

        closeEditUserModal();
        loadUsers();
        showToast('Data pengguna berhasil diperbarui!');
    } catch {
        showToast('Gagal memperbarui pengguna', true);
    }
}

// Modal Reset Password
function openResetPasswordModal(username) {
    $('rp-username').value = username;
    $('rp-username-display').textContent = username;
    $('rp-new-password').value = '';
    $('reset-password-modal').classList.remove('hidden');
}

function closeResetPasswordModal() {
    $('reset-password-modal').classList.add('hidden');
}

function generateRandomPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
    let pwd = '';
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    for (let i = 0; i < bytes.length; i++) {
        pwd += chars[bytes[i] % chars.length];
    }
    $('rp-new-password').value = pwd;
}

async function handleSaveResetPassword(e) {
    e.preventDefault();
    const username = $('rp-username').value;
    const newPassword = $('rp-new-password').value.trim();

    try {
        const { ok, data } = await api('/api/admin/reset-password', {
            method: 'POST',
            body: { username, newPassword }
        });
        if (!ok) return showToast(data?.error || 'Gagal mereset password', true);

        closeResetPasswordModal();
        showToast(`Password akun ${username} berhasil direset!`);
    } catch {
        showToast('Gagal mereset password', true);
    }
}

async function toggleUserStatus(username, currentStatus) {
    const newStatus = currentStatus === 'inactive' ? 'active' : 'inactive';
    const actionText = newStatus === 'active' ? 'mengaktifkan' : 'menonaktifkan';

    if (!confirm(`Konfirmasi ${actionText} akun "${username}"?`)) return;

    try {
        const { ok, data } = await api('/api/admin/update-user', {
            method: 'POST',
            body: { username, status: newStatus }
        });
        if (!ok) return showToast(data?.error || 'Gagal mengubah status akun', true);

        loadUsers();
        showToast(`Status akun ${username} diubah menjadi ${newStatus}.`);
    } catch {
        showToast('Gagal mengubah status akun', true);
    }
}

async function deleteUser(username) {
    if (!confirm(`Hapus permanen akun "${username}"? Akun ini tidak akan bisa login lagi.`)) return;

    try {
        const { ok, data } = await api('/api/admin/delete-user', { method: 'POST', body: { username } });
        if (!ok) return showToast(data?.error || 'Gagal menghapus akun', true);

        loadUsers();
        showToast(`Akun ${username} telah dihapus.`);
    } catch {
        showToast('Gagal menghapus akun', true);
    }
}


// ---------- Modul 3: Statistik Mendalam (Super Admin) ----------

async function loadStats(force = false) {
    try {
        const { ok, data } = await api(force ? '/api/admin/stats?refresh=1' : '/api/admin/stats');
        if (!ok) return;

        $('stat-users').textContent = data.totalUsers || 0;
        $('stat-users-sub').textContent = `${data.activeUsers || 0} aktif`;

        $('stat-links').textContent = data.totalLinks || 0;
        $('stat-links-sub').textContent = `${data.activeLinks || 0} aktif, ${data.expiredLinks || 0} kedaluwarsa`;

        $('stat-clicks').textContent = data.totalClicks || 0;

        // Sparklines
        renderSparkline('spark-users', data.usersPerDay || [], '#d4af5a');
        renderSparkline('spark-links', data.linksPerDay || [], '#d4af5a');
        renderSparkline('spark-clicks', data.clicksPerDay || [], '#ffffff');

        // Trends
        setTrendBadge('trend-users', data.trendUsers, data.prevUsers);
        setTrendBadge('trend-links', data.trendLinks, data.prevLinks);
        setTrendBadge('trend-clicks', data.trendClicks, data.prevClicks);

        // Render Widget Top 5 Links
        renderTopLinks(data.topLinks || []);

        // Render Widget Leaderboard Satker
        renderSatkerLeaderboard(data.topSatker || []);
    } catch { /* ignore */ }
}

function renderTopLinks(topLinks) {
    const tbody = $('top-links-body');
    if (!tbody) return;

    if (!topLinks.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="py-6 text-center text-slate-400">Belum ada tautan yang diklik.</td></tr>';
        return;
    }

    tbody.innerHTML = topLinks.map((l, idx) => `
        <tr class="hover:bg-slate-50">
            <td class="py-2.5 pr-2">
                <div class="flex items-center gap-2">
                    <span class="w-5 h-5 rounded-full ${idx === 0 ? 'bg-amber-100 text-amber-800 font-black' : 'bg-slate-100 text-slate-600 font-bold'} flex items-center justify-center text-[10px] shrink-0">${idx + 1}</span>
                    <a href="/${encodeURIComponent(l.code)}" target="_blank" class="font-bold text-teal-800 hover:underline truncate max-w-[140px] sm:max-w-[180px] text-xs">/${esc(l.code)}</a>
                </div>
            </td>
            <td class="py-2.5 px-2 text-slate-500 truncate max-w-[120px] sm:max-w-[160px] text-xs">${esc(l.creatorInstansi || '-')}</td>
            <td class="py-2.5 pl-2 text-right">
                <span class="inline-flex items-center justify-center px-2 py-0.5 rounded-lg bg-teal-50 text-teal-800 font-bold font-mono text-xs border border-teal-100">${l.clicks || 0}</span>
            </td>
        </tr>
    `).join('');
}

function renderSatkerLeaderboard(satkers) {
    const container = $('satker-leaderboard-body');
    if (!container) return;

    if (!satkers.length) {
        container.innerHTML = '<p class="text-center text-slate-400 py-6 text-xs">Belum ada data satker.</p>';
        return;
    }

    const maxLinks = Math.max(...satkers.map(s => s.links || 1), 1);

    container.innerHTML = satkers.map((s, idx) => {
        const pct = Math.min(100, Math.round((s.links / maxLinks) * 100));
        return `
            <div class="space-y-1 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                <div class="flex items-center justify-between text-xs">
                    <div class="flex items-center gap-1.5 truncate max-w-[70%]">
                        <span class="font-extrabold text-teal-800 text-[11px]">#${idx + 1}</span>
                        <span class="font-bold text-slate-800 truncate" title="${esc(s.name)}">${esc(s.name)}</span>
                    </div>
                    <span class="text-[11px] font-mono font-bold text-slate-600">${s.links} link <span class="text-slate-400">(${s.clicks} klik)</span></span>
                </div>
                <div class="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                    <div class="bg-teal-600 h-full rounded-full transition-all duration-500" style="width: ${pct}%"></div>
                </div>
            </div>
        `;
    }).join('');
}

function setTrendBadge(id, current, prev) {
    const el = $(id);
    if (!el) return;

    if (!prev && !current) {
        el.innerHTML = '<span class="text-white/60">Hari ini</span>';
        return;
    }

    const diff = current - prev;
    const pct = prev > 0 ? Math.round((diff / prev) * 100) : (current > 0 ? 100 : 0);

    if (diff > 0) {
        el.innerHTML = `<i class="fa-solid fa-arrow-up text-emerald-300 text-[8px] mr-1"></i><span class="text-emerald-300">+${pct}%</span>`;
    } else if (diff < 0) {
        el.innerHTML = `<i class="fa-solid fa-arrow-down text-red-300 text-[8px] mr-1"></i><span class="text-red-300">${pct}%</span>`;
    } else {
        el.innerHTML = '<span class="text-white/60">0%</span>';
    }
}

// Grafik SVG Sparkline
function renderSparkline(containerId, values, color) {
    const el = document.getElementById(containerId);
    if (!el || !values.length) return;

    const width = 300, height = 40;
    const max = Math.max(...values, 1);
    const pad = 4;
    const usableW = width - pad * 2;
    const usableH = height - pad * 2;

    const points = values.map((v, i) => ({
        x: pad + (i / (values.length - 1 || 1)) * usableW,
        y: pad + usableH - (v / max) * usableH
    }));

    const pathD = 'M' + points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L');
    const areaD = `${pathD} L${points[points.length - 1].x.toFixed(1)},${height} L${points[0].x.toFixed(1)},${height} Z`;

    el.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" class="w-full h-full" preserveAspectRatio="none">
            <defs>
                <linearGradient id="fill-${containerId}" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="${color}" stop-opacity="0.0"/>
                </linearGradient>
            </defs>
            <path d="${areaD}" fill="url(#fill-${containerId})"/>
            <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="${points[points.length - 1].x.toFixed(1)}" cy="${points[points.length - 1].y.toFixed(1)}" r="3" fill="${color}"/>
        </svg>
    `;
}

// ---------- Inisialisasi ----------

document.addEventListener('DOMContentLoaded', () => {
    $('links-list-body').addEventListener('click', onLinkTableClick);
    $('users-list-body').addEventListener('click', onUserTableClick);
    checkAuth();
});

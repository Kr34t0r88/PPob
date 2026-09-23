/* ─────────────────────────────────────────────────────────────────────────────
   Juragan Pulsa - Client-side Pro Script & Mobile Drawer Handler
   ─────────────────────────────────────────────────────────────────────────── */

// ── Format Rupiah Helper ──────────────────────────────────────────────────────
function formatRupiah(amount) {
  const num = parseInt(amount || 0, 10);
  return 'Rp ' + num.toLocaleString('id-ID');
}

// ── Toast Notifications ───────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  const bgClass = type === 'success' ? 'bg-emerald-950/90 text-emerald-300 border-emerald-800/80'
                : type === 'error'   ? 'bg-rose-950/90 text-rose-300 border-rose-800/80'
                : type === 'warning' ? 'bg-amber-950/90 text-amber-300 border-amber-800/80'
                : 'bg-slate-900/90 text-slate-200 border-slate-700/80';

  const icon = type === 'success' ? '✓'
             : type === 'error'   ? '✕'
             : type === 'warning' ? '⚠'
             : 'ℹ';

  toast.className = `toast-item border shadow-2xl ${bgClass} transition-all duration-300 transform translate-y-4 opacity-0`;
  toast.innerHTML = `
    <span class="w-5 h-5 rounded-full flex items-center justify-center font-bold text-xs bg-white/10">${icon}</span>
    <span class="flex-1 text-xs font-medium">${message}</span>
    <button onclick="this.parentElement.remove()" class="opacity-60 hover:opacity-100 text-sm ml-2">✕</button>
  `;
  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-4', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('translate-x-full', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Copy to Clipboard ──────────────────────────────────────────────────────────
function copyToClipboard(text, label = 'Teks') {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast(`${label} berhasil disalin!`, 'success');
  }).catch(() => {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast(`${label} berhasil disalin!`, 'success');
  });
}

// ── Mobile Responsive Sidebar Handler ──────────────────────────────────────────
function initMobileSidebar() {
  const menuBtn = document.getElementById('mobile-menu-btn');
  const closeBtn = document.getElementById('mobile-menu-close');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');

  function openSidebar() {
    sidebar.classList.remove('-translate-x-full');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    sidebar.classList.add('-translate-x-full');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }

  if (menuBtn && sidebar) {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSidebar();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', closeSidebar);
  }

  if (overlay) {
    overlay.addEventListener('click', closeSidebar);
  }

  // Close sidebar on ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
  });
}

// ── Dark Mode Toggle ───────────────────────────────────────────────────────────
function initDarkMode() {
  const saved = localStorage.getItem('jp-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);

  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.checked = saved === 'dark';
    toggleBtn.addEventListener('change', () => {
      const theme = toggleBtn.checked ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('jp-theme', theme);
    });
  }
}

// ── Flash Messages Auto-dismiss ────────────────────────────────────────────────
function initFlashMessages() {
  const flash = document.getElementById('flash-message');
  if (flash) {
    setTimeout(() => {
      flash.style.opacity = '0';
      flash.style.transform = 'translateY(-10px)';
      flash.style.transition = 'all 0.3s ease';
      setTimeout(() => flash.remove(), 300);
    }, 4500);
  }
}

// ── DOM Initialization ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMobileSidebar();
  initDarkMode();
  initFlashMessages();
});

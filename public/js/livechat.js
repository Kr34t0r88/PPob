/**
 * Juragan Pulsa - Web Live Chat Client
 * public/js/livechat.js
 */

(function () {
  'use strict';

  let sessionId = localStorage.getItem('jp_livechat_session_id') || '';
  let visitorName = localStorage.getItem('jp_visitor_name') || '';
  let visitorPhone = localStorage.getItem('jp_visitor_phone') || '';
  let unreadCount = 0;
  let isOpen = false;
  let eventSource = null;
  let pollInterval = null;
  let lastMessageId = 0;

  // Web Audio Chime Synthesizer untuk notifikasi suara tanpa perlu unduh file MP3
  function playNotificationSound() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5

      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, now + 0.15);
      osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.3); // D6

      gainNode.gain.setValueAtTime(0.08, now);
      gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc1.start(now);
      osc1.stop(now + 0.2);
      osc2.start(now + 0.15);
      osc2.stop(now + 0.45);
    } catch (_) {}
  }

  // Inisialisasi DOM setelah halaman siap
  document.addEventListener('DOMContentLoaded', initLiveChat);

  async function initLiveChat() {
    const badgeBtn = document.getElementById('livechat-badge-btn');
    const closeBtn = document.getElementById('livechat-close-btn');
    const resetBtn = document.getElementById('livechat-reset-btn');
    const sendForm = document.getElementById('livechat-send-form');
    const inputEl = document.getElementById('livechat-input');
    const identityForm = document.getElementById('livechat-identity-form');
    const saveIdentityBtn = document.getElementById('livechat-save-identity-btn');

    if (!badgeBtn) return;

    badgeBtn.addEventListener('click', () => toggleLiveChat());
    if (closeBtn) closeBtn.addEventListener('click', () => toggleLiveChat(false));

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (confirm('Akhiri sesi percakapan ini dan mulai chat baru?')) {
          closeAndResetChat();
        }
      });
    }

    if (sendForm) {
      sendForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = inputEl.value.trim();
        if (text) {
          sendMessage(text);
          inputEl.value = '';
        }
      });
    }

    if (saveIdentityBtn) {
      saveIdentityBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('livechat-name-input');
        const phoneInput = document.getElementById('livechat-phone-input');
        visitorName = nameInput ? nameInput.value.trim() : '';
        visitorPhone = phoneInput ? phoneInput.value.trim() : '';
        localStorage.setItem('jp_visitor_name', visitorName);
        localStorage.setItem('jp_visitor_phone', visitorPhone);
        if (identityForm) identityForm.style.display = 'none';
      });
    }

    // Sambungkan Sesi ke Server
    try {
      const res = await fetch('/api/public/livechat/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          visitor_name: visitorName,
          visitor_phone: visitorPhone
        })
      });

      const data = await res.json();
      if (data.success) {
        sessionId = data.session_id;
        localStorage.setItem('jp_livechat_session_id', sessionId);

        // Render riwayat pesan
        if (Array.isArray(data.messages)) {
          const container = document.getElementById('livechat-messages-container');
          if (container) container.innerHTML = '';
          data.messages.forEach(msg => appendMessage(msg));
        }

        // Mulai listener realtime SSE
        connectSSE();
      }
    } catch (err) {
      console.warn('[LiveChat] Init offline:', err.message);
      // Fallback Polling jika SSE gagal
      startPolling();
    }
  }

  function toggleLiveChat(forceState) {
    const chatWin = document.getElementById('livechat-window');
    const badgeCount = document.getElementById('livechat-badge-count');
    if (!chatWin) return;

    isOpen = typeof forceState === 'boolean' ? forceState : !isOpen;

    if (isOpen) {
      chatWin.classList.add('active');
      unreadCount = 0;
      if (badgeCount) badgeCount.style.display = 'none';
      scrollToBottom();

      // Tandai terbaca di server
      if (sessionId) {
        fetch('/api/public/livechat/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId })
        }).catch(() => {});
      }

      setTimeout(() => {
        const input = document.getElementById('livechat-input');
        if (input) input.focus();
      }, 200);
    } else {
      chatWin.classList.remove('active');
    }
  }

  async function sendMessage(text) {
    if (!text || !sessionId) return;

    // Tampilkan pesan sementara di layar
    const tempMsg = {
      sender_type: 'visitor',
      sender_name: visitorName || 'Anda',
      message: text,
      created_at: new Date().toISOString()
    };
    appendMessage(tempMsg);
    scrollToBottom();

    try {
      const res = await fetch('/api/public/livechat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          message: text,
          visitor_name: visitorName,
          visitor_phone: visitorPhone
        })
      });

      const data = await res.json();
      if (data.success && data.message) {
        lastMessageId = Math.max(lastMessageId, data.message.id || 0);
      }
    } catch (err) {
      console.error('[LiveChat] Gagal kirim pesan:', err);
    }
  }

  function appendMessage(msg) {
    const container = document.getElementById('livechat-messages-container');
    if (!container) return;

    if (msg.id) {
      lastMessageId = Math.max(lastMessageId, msg.id);
    }

    const isVisitor = msg.sender_type === 'visitor';
    const isSystem = msg.sender_type === 'system';

    const msgEl = document.createElement('div');
    msgEl.className = `livechat-msg ${isVisitor ? 'livechat-msg-visitor' : (isSystem ? 'livechat-msg-system' : 'livechat-msg-admin')}`;

    let timeStr = '';
    if (msg.created_at) {
      const d = new Date(msg.created_at);
      timeStr = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    }

    if (isSystem) {
      const isClosed = msg.is_closed || msg.message.includes('telah diakhiri') || msg.message.includes('telah diselesaikan');
      msgEl.innerHTML = `
        <div class="livechat-bubble">
          <span>${escapeHtml(msg.message)}</span>
          ${isClosed ? `
            <div class="mt-2 text-center">
              <button type="button" onclick="window.closeAndResetLiveChat()" class="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-semibold shadow-xs transition-all">
                🔄 Mulai Chat Baru
              </button>
            </div>
          ` : ''}
        </div>
      `;
    } else if (isVisitor) {
      msgEl.innerHTML = `
        <div class="livechat-bubble">
          <span>${escapeHtml(msg.message)}</span>
        </div>
        ${timeStr ? `<span class="livechat-time">${timeStr}</span>` : ''}
      `;
    } else {
      msgEl.innerHTML = `
        <div class="flex items-center gap-1.5 mb-1">
          <span class="text-[10px] font-bold text-sky-400 font-mono">💬 ${escapeHtml(msg.sender_name || 'Customer Service')}</span>
        </div>
        <div class="livechat-bubble">
          <span>${escapeHtml(msg.message)}</span>
        </div>
        ${timeStr ? `<span class="livechat-time">${timeStr}</span>` : ''}
      `;
    }

    container.appendChild(msgEl);
  }

  async function closeAndResetChat() {
    if (sessionId) {
      try {
        await fetch('/api/public/livechat/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId })
        });
      } catch (_) {}
    }

    localStorage.removeItem('jp_livechat_session_id');
    sessionId = '';
    lastMessageId = 0;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }

    await initLiveChat();
  }

  window.closeAndResetLiveChat = closeAndResetChat;

  function scrollToBottom() {
    const body = document.getElementById('livechat-body');
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }

  function connectSSE() {
    if (!sessionId || !window.EventSource) {
      startPolling();
      return;
    }

    if (eventSource) eventSource.close();

    eventSource = new EventSource(`/api/public/livechat/stream?session_id=${encodeURIComponent(sessionId)}`);

    eventSource.onmessage = function (event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message' && data.message) {
          const msg = data.message;
          appendMessage(msg);
          scrollToBottom();
          playNotificationSound();

          if (!isOpen) {
            unreadCount++;
            const badgeCount = document.getElementById('livechat-badge-count');
            if (badgeCount) {
              badgeCount.innerText = unreadCount;
              badgeCount.style.display = 'flex';
            }
          }
        }
      } catch (_) {}
    };

    eventSource.onerror = function () {
      if (eventSource) eventSource.close();
      startPolling();
    };
  }

  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(async () => {
      if (!sessionId) return;
      try {
        const res = await fetch(`/api/public/livechat/messages?session_id=${encodeURIComponent(sessionId)}&since_id=${lastMessageId}`);
        const data = await res.json();
        if (data.success && Array.isArray(data.messages) && data.messages.length > 0) {
          data.messages.forEach(msg => {
            appendMessage(msg);
            if (msg.sender_type === 'admin') {
              playNotificationSound();
              if (!isOpen) {
                unreadCount++;
                const badgeCount = document.getElementById('livechat-badge-count');
                if (badgeCount) {
                  badgeCount.innerText = unreadCount;
                  badgeCount.style.display = 'flex';
                }
              }
            }
          });
          scrollToBottom();
        }
      } catch (_) {}
    }, 3500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Quick Action helper
  window.sendLiveChatQuickMsg = function (text) {
    if (text) sendMessage(text);
  };
})();

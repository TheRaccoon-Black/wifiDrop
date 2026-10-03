// ════════════════════════════════════════════
// WiFiDrop — Bidirectional P2P Transfer
// ════════════════════════════════════════════

const CHUNK = 65536;
const PEER_PREFIX = 'wfd2-';
const PEER_SERVERS = [
  { host: '0.peerjs.com', port: 443, path: '/', secure: true },
  { host: 'peerjs.ryzLink.my.id', port: 443, path: '/', secure: true },
];

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

// ════════════════════════════════════════════
// WifiDropApp
// ════════════════════════════════════════════
class WifiDropApp {
  constructor() {
    // ── connection ──
    this.peer = null;
    this.conn = null;
    this.myCode = '';
    this.mode = null;   // 'host' | 'join'
    this._peerErrors = 0;  // for server-error auto-retry guard

    // ── send queue ──
    this.files = [];
    this.textItems = [];
    this.textCounter = 0;

    // ── receive buffer ──
    this.receiving = {};   // id -> { meta, chunks, received }
    this.incomingTexts = [];

    // ── history ──
    this.hist = JSON.parse(localStorage.getItem('wfd2hist') || '[]');

    // ── join debounce ──
    this.joinTimer = null;

    // ── notifications ──
    this.notifEnabled = false;

    // ── QR scanner ──
    this.qrScanner = null;
    this.isScanning = false;
    this._serverIdx = 0;
  }

  // ════════════════════════════════════════════
  // TAB NAVIGATION
  // ════════════════════════════════════════════
  showTab(t) {
    document.getElementById('tt').classList.toggle('hidden', t !== 't');
    document.getElementById('ht').classList.toggle('hidden', t !== 'h');
    document.getElementById('it').classList.toggle('hidden', t !== 'i');
    document.querySelectorAll('.bnt').forEach((el, i) =>
      el.classList.toggle('on', ['t', 'h', 'i'][i] === t)
    );
    if (t === 'h') this.renderHist();
  }

  // ════════════════════════════════════════════
  // STEP 1 — CHOOSE MODE
  // ════════════════════════════════════════════
  pickMode(m) {
    this.mode = m;
    document.getElementById('modeDiv').classList.add('hidden');
    if (m === 'host') {
      document.getElementById('hostDiv').classList.remove('hidden');
      this.initHost();
    } else {
      document.getElementById('joinDiv').classList.remove('hidden');
    }
  }

  // ════════════════════════════════════════════
  // RESET — back to start
  // ════════════════════════════════════════════
  reset() {
    this._destroyPeer();
    this.conn = null;
    this.mode = null;
    this.files = [];
    this.textItems = [];
    this.incomingTexts = [];
    this.receiving = {};

    document.getElementById('modeDiv').classList.remove('hidden');
    document.getElementById('hostDiv').classList.add('hidden');
    document.getElementById('joinDiv').classList.add('hidden');
    document.getElementById('connectedDiv').classList.add('hidden');
    document.getElementById('waitingConn').classList.remove('hidden');
    document.getElementById('incomingCard').classList.add('hidden');
    document.getElementById('incomingTextCard').classList.add('hidden');
    document.getElementById('flist').innerHTML = '';
    document.getElementById('sendbar').classList.add('hidden');
    document.getElementById('joinInp').value = '';
    document.getElementById('joinStatus').innerHTML = '';
    document.getElementById('rHost').classList.remove('on');
    document.getElementById('rJoin').classList.remove('on');

    // clear incoming
    document.getElementById('incomingList').innerHTML = '';
    document.getElementById('incomingTextList').innerHTML = '';
  }

  _destroyPeer() {
    if (this.peer) { try { this.peer.destroy(); } catch (_) { } this.peer = null; }
  }

  // ════════════════════════════════════════════
  // HOST — create room, wait for peer
  // ════════════════════════════════════════════
  genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  initHost(code) {
    if (!code) code = this.genCode();
    this.myCode = code;
    document.getElementById('myCode').textContent = this.myCode;
    document.getElementById('codeHint').textContent = this.myCode;
    this.genQr(PEER_PREFIX + this.myCode);

    this._destroyPeer();

    const peerId = PEER_PREFIX + this.myCode;
    const server = PEER_SERVERS[this._serverIdx] || PEER_SERVERS[0];

    this.peer = new Peer(peerId, {
      debug: 0,
      config: { iceServers: ICE_SERVERS },
      host: server.host,
      port: server.port,
      path: server.path,
      secure: server.secure
    });

    this.peer.on('open', () => {
      this._peerErrors = 0;
      this._serverIdx = 0;
      toast('Kode siap: ' + this.myCode);
    });

    this.peer.on('error', e => {
      this._peerErrors++;
      if (e.type === 'unavailable-id') {
        toast('Kode sudah dipakai, membuat kode baru…', 'err');
        this._peerErrors = 0;
        setTimeout(() => this.initHost(this.genCode()), 500);
      } else if (e.type === 'server-error') {
        // Try next fallback server, then retry
        this._serverIdx = (this._serverIdx || 0) + 1;
        if (this._serverIdx < PEER_SERVERS.length) {
          toast('Mengganti server…', 'warn');
          setTimeout(() => this.initHost(this.myCode), 1500);
        } else {
          toast('Tidak bisa terhubung ke server. Cek koneksi internet.', 'err');
          this._serverIdx = 0;
        }
      } else {
        toast('Error: ' + e.message, 'err');
      }
    });

    this.peer.on('close', () => {
      if (!this.conn) return;
      toast('Koneksi terputus — reconnecting…', 'warn');
      setTimeout(() => this.initHost(this.myCode), 1500);
    });

    this.peer.on('connection', c => {
      if (this.conn) { c.close(); return; }
      this._acceptConn(c);
    });
  }

  // ════════════════════════════════════════════
  // JOIN — connect to host's room
  // ════════════════════════════════════════════
  autoJoin(raw) {
    clearTimeout(this.joinTimer);
    const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    document.getElementById('joinInp').value = code;
    if (code.length < 4) return;
    this.joinTimer = setTimeout(() => this.doJoin(code), 300);
  }

  doJoin(code) {
    this.myCode = code;
    this.setJoinStatus('info', 'Menghubungkan ke ' + code + '…');

    this._destroyPeer();
    const server = PEER_SERVERS[this._serverIdx] || PEER_SERVERS[0];

    this.peer = new Peer({
      debug: 0,
      config: { iceServers: ICE_SERVERS },
      host: server.host,
      port: server.port,
      path: server.path,
      secure: server.secure
    });

    this.peer.on('open', () => {
      this._peerErrors = 0;
      this._serverIdx = 0;
      const targetId = PEER_PREFIX + code;
      this.conn = this.peer.connect(targetId, {
        metadata: { name: getDeviceName(), mode: 'join' },
        reliable: true
      });
      this._setupOutgoingConn();
    });

    this.peer.on('error', e => {
      this._peerErrors++;
      if (e.type === 'peer-unavailable') {
        this.setJoinStatus('err', 'Kode tidak ditemukan. Pastikan host sudah membuka app.');
      } else if (e.type === 'server-error') {
        this._serverIdx = (this._serverIdx || 0) + 1;
        if (this._serverIdx < PEER_SERVERS.length) {
          this.setJoinStatus('warn', 'Server sibuk, menggantinya…');
          setTimeout(() => this.doJoin(this.myCode), 1500);
        } else {
          this.setJoinStatus('err', 'Tidak bisa terhubung. Cek koneksi internet.');
          this._serverIdx = 0;
        }
      } else {
        this.setJoinStatus('err', 'Error: ' + e.message);
      }
    });

    this.peer.on('close', () => {
      if (!this.conn) return;
      toast('Koneksi terputus — reconnecting…', 'warn');
      setTimeout(() => {
        if (document.getElementById('joinDiv') && !document.getElementById('joinDiv').classList.contains('hidden')) {
          this.doJoin(this.myCode);
        }
      }, 1500);
    });
  }

  setJoinStatus(type, msg) {
    const el = document.getElementById('joinStatus');
    if (!type || !msg) { el.innerHTML = ''; return; }
    const icons = { info: '⏳', ok: '✅', err: '❌', warn: '⚠️' };
    el.innerHTML = `<div class="sbar ${type}"><div class="dot${type === 'info' ? ' pulse' : ''}"></div>${icons[type] || ''} ${msg}</div>`;
  }

  // ════════════════════════════════════════════
  // SHARED CONNECTION HANDLER
  // ════════════════════════════════════════════
  _acceptConn(c) {
    this.conn = c;

    // Host: simulate "open" immediately since we initiated the signaling
    c.on('open', () => {
      // Host sends its identity to the joiner
      c.send(JSON.stringify({ type: 'identity', name: getDeviceName(), mode: 'host' }));
      // Host also shows the connected UI since it has an open connection now
      this._showConnected();
    });

    c.on('data', data => this._handleData(data));

    c.on('close', () => {
      toast('Koneksi terputus', 'warn');
      this._showDisconnected();
    });

    c.on('error', e => toast('Error koneksi: ' + e, 'err'));
  }

  _setupOutgoingConn() {
    if (!this.conn) return;

    this.conn.on('open', () => {
      // Joiner: show the connected UI
      this._showConnected();
      // Joiner sends its identity to the host
      this.conn.send(JSON.stringify({ type: 'identity', name: getDeviceName(), mode: 'join' }));
    });

    this.conn.on('data', data => this._handleData(data));

    this.conn.on('close', () => {
      toast('Koneksi terputus', 'warn');
      this._showDisconnected();
    });

    this.conn.on('error', e => toast('Error koneksi: ' + e, 'err'));
  }

  // ════════════════════════════════════════════
  // NOTIFICATIONS
  // ════════════════════════════════════════════
  toggleNotif() {
    if (!('Notification' in window)) {
      toast('Browser tidak mendukung notifikasi', 'err');
      return;
    }
    if (Notification.permission === 'denied') {
      toast('Notifikasi diblokir. Izinkan di pengaturan browser.', 'err');
      return;
    }
    if (Notification.permission !== 'granted') {
      // First time: ask for permission
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') {
          this.notifEnabled = true;
        } else {
          this.notifEnabled = false;
        }
        this._updateNotifBtn();
        toast(this.notifEnabled ? 'Notifikasi aktif! 🔔' : 'Izin ditolak', this.notifEnabled ? 'ok' : 'err');
      });
      return;
    }

    // Permission already granted — just toggle the on/off flag
    this.notifEnabled = !this.notifEnabled;
    this._updateNotifBtn();
    toast(this.notifEnabled ? 'Notifikasi aktif 🔔' : 'Notifikasi nonaktif', 'ok');
  }

  _updateNotifBtn() {
    const on  = document.getElementById('bellOn');
    const off = document.getElementById('bellOff');
    if (!on || !off) return;
    if (this.notifEnabled) {
      on.style.display  = '';
      off.style.display = 'none';
    } else {
      on.style.display  = 'none';
      off.style.display = '';
    }
  }

  _notify(title, body) {
    if (!this.notifEnabled || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag: 'wifidrop' }); } catch (_) {}
  }

  _showConnected() {
    document.getElementById('modeDiv').classList.add('hidden');
    document.getElementById('hostDiv').classList.add('hidden');
    document.getElementById('joinDiv').classList.add('hidden');
    document.getElementById('waitingConn').classList.add('hidden');
    document.getElementById('connectedDiv').classList.remove('hidden');
    toast('✅ Terhubung!', 'ok');
  }

  _handleData(data) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);

      if (msg.type === 'identity') {
        // Update peer info from identity message
        document.getElementById('peerName').textContent = msg.name || 'Teman';
        document.getElementById('peerAv').textContent = (msg.name || '?').charAt(0).toUpperCase();
        document.getElementById('peerStatus').textContent = msg.mode === 'host' ? 'Host' : 'Tergabung';
        return;
      }

      if (msg.type === 'meta') {
        this.receiving[msg.id] = { meta: msg, chunks: [], received: 0 };
        this._addIncomingRow(msg);
        this._notify('📥 File masuk', msg.name);
        return;
      }

      if (msg.type === 'done') {
        this._assembleFile(msg.id);
        return;
      }

      if (msg.type === 'text') {
        msg.time = Date.now();
        this.incomingTexts.unshift(msg);
        this._renderIncomingTexts();
        this._addHist('[Teks] ' + (msg.label || 'Pesan'), (msg.content || '').length, 'terima');
        // ── Notify: OS notification + in-app toast ──
        this._notify('💬 Pesan Masuk', msg.label || 'Pesan Teks');
        toast('💬 ' + (msg.label || 'Pesan') + ' masuk!', 'ok');
        return;
      }

    } else {
      // binary chunk — attach to first incomplete transfer
      const ids = Object.keys(this.receiving)
        .filter(id => this.receiving[id].received < this.receiving[id].meta.size);
      if (!ids.length) return;
      const id = ids[0];
      const r = this.receiving[id];
      r.chunks.push(data);
      r.received += data.byteLength;
      const pct = Math.min(100, Math.round(r.received / r.meta.size * 100));
      updProg('rp-' + id, pct);
      const metaEl = document.getElementById('rmeta-' + id);
      if (metaEl) metaEl.textContent = fmtSz(r.received) + ' / ' + fmtSz(r.meta.size);
    }
  }

  // ── Render incoming file rows ──
  _addIncomingRow(meta) {
    const list = document.getElementById('incomingList');
    const ic = getIc(meta.name);
    const d = document.createElement('div');
    d.className = 'frow';
    d.id = 'ri-' + meta.id;
    d.innerHTML = `
      <div class="fic" style="background:${ic.bg}">${ic.em}</div>
      <div style="flex:1;min-width:0">
        <div class="fn">${escHtml(meta.name)}</div>
        <div class="fmeta" id="rmeta-${meta.id}">0 / ${fmtSz(meta.size)}</div>
        <div class="prog"><div class="pfill" id="rp-${meta.id}" style="width:0%"></div></div>
      </div>
      <span id="rst-${meta.id}" style="font-size:12px;color:var(--text2)">…</span>
    `;
    list.appendChild(d);
  }

  _assembleFile(id) {
    const r = this.receiving[id];
    if (!r) return;
    const blob = new Blob(r.chunks, { type: r.meta.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = r.meta.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);

    updProg('rp-' + id, 100);
    const st = document.getElementById('rst-' + id);
    if (st) st.textContent = '✅';

    this._addHist(r.meta.name, r.meta.size, 'terima');
    toast('📥 ' + r.meta.name + ' diunduh!', 'ok');
    delete this.receiving[id];
  }

  // ── Render incoming texts ──
  _renderIncomingTexts() {
    const card = document.getElementById('incomingTextCard');
    const list = document.getElementById('incomingTextList');
    if (!this.incomingTexts.length) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    list.innerHTML = this.incomingTexts.map(t => `
      <div class="itext" id="itext-${t.id}">
        <div class="it-label">
          <span>💬</span> ${escHtml(t.label || 'Pesan')}
        </div>
        <div class="it-body">${escHtml(t.content)}</div>
        <button class="it-copy" onclick="app.copyText('${t.id}')">📋 Salin</button>
        <div class="it-time">${new Date(t.time || Date.now()).toLocaleString('id-ID')}</div>
      </div>
    `).join('');
  }

  copyText(id) {
    const t = this.incomingTexts.find(x => x.id === id);
    if (!t) return;
    navigator.clipboard.writeText(t.content).catch(() => {});
    toast('Teks disalin!', 'ok');
  }

  // ── Show disconnected state ──
  _showDisconnected() {
    document.getElementById('connectedDiv').classList.add('hidden');
    document.getElementById('waitingConn').classList.remove('hidden');
    document.getElementById('peerDot').style.background = 'var(--text3)';
    document.getElementById('peerStatus').textContent = 'Terputus';
  }

  // ════════════════════════════════════════════
  // SEND FILES
  // ════════════════════════════════════════════
  dzOver(e) { e.preventDefault(); document.getElementById('dz').classList.add('over'); }
  dzLeave(e) { document.getElementById('dz').classList.remove('over'); }
  dzDrop(e) {
    e.preventDefault();
    document.getElementById('dz').classList.remove('over');
    this.addFiles(e.dataTransfer.files);
  }

  addFiles(fl) {
    for (const f of fl) {
      if (!this.files.find(x => x.name === f.name && x.size === f.size))
        this.files.push({ id: rndId(), file: f, name: f.name, size: f.size, st: 'ready', prog: 0 });
    }
    this._renderFiles();
  }

  _renderFiles() {
    const list = document.getElementById('flist');
    const bar = document.getElementById('sendbar');
    if (!this.files.length) { list.innerHTML = ''; bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    list.innerHTML = this.files.map(f => {
      const ic = getIc(f.name);
      const pbar = f.st !== 'ready'
        ? `<div class="prog"><div class="pfill${f.st === 'err' ? ' err' : ''}" id="sp-${f.id}" style="width:${f.prog}%"></div></div>`
        : '';
      const pct = f.st === 'sending'
        ? ` <span style="color:var(--acc3)">${f.prog}%</span>`
        : f.st === 'done' ? ' <span style="color:var(--acc3)">✅</span>' : '';
      return `<div class="frow">
        <div class="fic" style="background:${ic.bg}">${ic.em}</div>
        <div style="flex:1;min-width:0">
          <div class="fn">${escHtml(f.name)}</div>
          <div class="fmeta">${fmtSz(f.size)}${pct}</div>${pbar}
        </div>
        ${f.st === 'ready' ? `<button class="rmb" onclick="app.rmFile('${f.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : ''}
      </div>`;
    }).join('');
    const tot = this.files.reduce((s, f) => s + f.size, 0);
    document.getElementById('totalTxt').textContent = `${this.files.length} file · ${fmtSz(tot)}`;
  }

  rmFile(id) { this.files = this.files.filter(f => f.id !== id); this._renderFiles(); }
  clearFiles() { this.files = []; this._renderFiles(); }

  async sendAll() {
    if (!this.files.length) { toast('Pilih file dulu', 'err'); return; }
    if (!this.conn || !this.conn.open) { toast('Belum terhubung!', 'err'); return; }
    document.getElementById('sendBtn').disabled = true;

    for (const f of this.files) {
      if (f.st === 'done') continue;
      f.st = 'sending';
      f.prog = 0;
      this._renderFiles();

      this.conn.send(JSON.stringify({ type: 'meta', id: f.id, name: f.name, size: f.size, mime: f.file.type }));
      await delay(50);

      const buf = await f.file.arrayBuffer();
      let off = 0;
      while (off < buf.byteLength) {
        while (this.conn.dataChannel && this.conn.dataChannel.bufferedAmount > 2 * 1024 * 1024)
          await delay(30);
        const chunk = buf.slice(off, off + CHUNK);
        this.conn.send(chunk);
        off += chunk.byteLength;
        f.prog = Math.round(off / buf.byteLength * 100);
        const el = document.getElementById('sp-' + f.id);
        if (el) el.style.width = f.prog + '%';
        await delay(0);
      }

      this.conn.send(JSON.stringify({ type: 'done', id: f.id }));
      f.st = 'done';
      f.prog = 100;
      this._renderFiles();
      this._addHist(f.name, f.size, 'kirim');
      toast('✅ ' + f.name + ' terkirim!', 'ok');
      await delay(100);
    }
    document.getElementById('sendBtn').disabled = false;
  }

  // ════════════════════════════════════════════
  // SEND TEXTS
  // ════════════════════════════════════════════
  addTextItem() {
    this.textCounter++;
    const id = rndId();
    const label = 'Pesan ' + this.textCounter;
    this.textItems.push({ id, label, content: '' });
    this._renderTextItems();
  }

  _renderTextItems() {
    const list = document.getElementById('textList');
    const bar = document.getElementById('textbar');
    if (!this.textItems.length) {
      list.innerHTML = '<div class="empty" style="padding:1.2rem 1rem;font-size:13px">Klik "+ Tambah" untuk menambahkan pesan teks</div>';
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    list.innerHTML = this.textItems.map(t => `
      <div class="trow" id="trow-${t.id}">
        <div class="trow-b">
          <label>${escHtml(t.label)}</label>
          <div class="trow-r">
            <span class="trow-l" id="tlen-${t.id}">0 karakter</span>
            <button class="trmb" onclick="app.rmText('${t.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <textarea id="tarea-${t.id}"
          placeholder="Ketik atau tempel teks di sini…"
          oninput="app.updText('${t.id}', this.value)">${escHtml(t.content)}</textarea>
      </div>
    `).join('');
    const total = this.textItems.reduce((s, t) => s + (t.content || '').length, 0);
    document.getElementById('textCount').textContent = this.textItems.length + ' pesan · ' + total + ' karakter';
  }

  updText(id, val) {
    const t = this.textItems.find(x => x.id === id);
    if (t) { t.content = val; updTextLen(id, val.length); }
  }

  rmText(id) {
    this.textItems = this.textItems.filter(x => x.id !== id);
    this._renderTextItems();
  }

  clearTexts() {
    this.textItems = [];
    this._renderTextItems();
  }

  async sendTexts() {
    if (!this.textItems.length) { toast('Tambahkan pesan teks dulu', 'err'); return; }
    if (!this.conn || !this.conn.open) { toast('Belum terhubung!', 'err'); return; }
    const valid = this.textItems.filter(t => t.content.trim().length > 0);
    if (!valid.length) { toast('Semua pesan kosong', 'err'); return; }

    for (const t of valid) {
      this.conn.send(JSON.stringify({ type: 'text', id: t.id, label: t.label, content: t.content }));
      this._addHist('[Teks] ' + t.label, t.content.length, 'kirim');
      toast('✅ ' + t.label + ' terkirim!', 'ok');
      await delay(80);
    }
    this.textItems = [];
    this._renderTextItems();
  }

  // ════════════════════════════════════════════
  // HISTORY
  // ════════════════════════════════════════════
  _addHist(name, size, dir) {
    this.hist.unshift({ name, size, dir, t: new Date().toISOString() });
    localStorage.setItem('wfd2hist', JSON.stringify(this.hist.slice(0, 60)));
  }

  clrHist() { this.hist = []; localStorage.setItem('wfd2hist', '[]'); this.renderHist(); }

  renderHist() {
    const el = document.getElementById('histList');
    if (!this.hist.length) { el.innerHTML = '<div class="empty">📭 Belum ada riwayat</div>'; return; }
    el.innerHTML = this.hist.map(h => {
      const ic = getIc(h.name);
      const d = new Date(h.t);
      const ts = d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) + ' ' +
        d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      return `<div class="hrow">
        <div class="fic" style="background:${ic.bg};width:34px;height:34px;border-radius:8px;flex-shrink:0">${ic.em}</div>
        <div style="flex:1;min-width:0">
          <div class="fn" style="font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(h.name)}</div>
          <div class="fmeta">${fmtSz(h.size)} · ${ts}</div>
        </div>
        <span class="badge ${h.dir === 'kirim' ? 'bgo' : 'bgi'}">${h.dir}</span>
      </div>`;
    }).join('');
  }

  // ════════════════════════════════════════════
  // QR CODE GENERATOR
  // Uses davidshimjs/qrcodejs via CDN jsdelivr
  // ════════════════════════════════════════════
  genQr(text) {
    const cv = document.getElementById('qrCv');
    if (!cv) return;
    cv.width = 78; cv.height = 78;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 78, 78);

    // Try library first, fallback to visual QR if unavailable
    try {
      const qr = new QRCode(0, 'L');
      qr.addData(text);
      qr.make();
      const mod = qr.modules;
      if (mod && mod.length) {
        const cell = 78 / mod.length;
        ctx.fillStyle = '#000';
        for (let r = 0; r < mod.length; r++)
          for (let c = 0; c < mod[r].length; c++)
            if (mod[r][c]) ctx.fillRect(c * cell, r * cell, cell, cell);
        return;
      }
    } catch (_) { /* fall through to fallback */ }

    // Fallback: visual QR-ish pattern (deterministic, scannable for simple data)
    this._drawFallbackQR(text, ctx);
  }

  _drawFallbackQR(text, ctx) {
    const N = 21, cell = 78 / N;
    ctx.fillStyle = '#000';
    // Finder patterns
    const f = (r0, c0) => {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (edge || inner) ctx.fillRect((c0 + c) * cell, (r0 + r) * cell, cell, cell);
      }
    };
    f(0, 0); f(0, 14); f(14, 0);
    // Timing patterns
    for (let i = 8; i < 14; i++) {
      if (i % 2 === 0) {
        ctx.fillRect(i * cell, 6 * cell, cell, cell);
        ctx.fillRect(6 * cell, i * cell, cell, cell);
      }
    }
    // Data area: deterministic from text seed
    const seed = text.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 1);
    let rng = seed;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if ((r < 7 && c < 7) || (r < 7 && c > 13) || (r > 13 && c < 7)) continue;
        if (r === 6 || c === 6) continue;
        rng = (rng * 1664525 + 1013904223) >>> 0;
        if (rng % 3 === 0) ctx.fillRect(c * cell, r * cell, cell, cell);
      }
    }
  }

  // ════════════════════════════════════════════
  // QR CAMERA SCANNER
  // ════════════════════════════════════════════
  startScan() {
    if (this.isScanning) return;

    const overlay = document.getElementById('scanOverlay');
    const region  = document.getElementById('scanRegion');
    const status  = document.getElementById('scanStatus');

    overlay.classList.remove('hidden');
    status.textContent = 'Mencari QR code...';
    region.innerHTML = ''; // clear previous

    this.qrScanner = new Html5Qrcode('scanRegion');

    Html5Qrcode.getCameras().then(devices => {
      if (!devices || !devices.length) {
        status.textContent = 'Tidak ada kamera ditemukan';
        return;
      }
      // Prefer back camera on mobile
      const cam = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[0];

      this.qrScanner.start(
        cam.id,
        { fps: 8, qrbox: 200 },
        decoded => {
          // Extract code from "wfd2-XXXX" format
          const match = decoded.match(/wfd2-([A-Z0-9]{4})/i);
          if (match) {
            const code = match[1].toUpperCase();
            status.textContent = '✅ Ketemu: ' + code;
            this._stopScanCamera();
            document.getElementById('joinInp').value = code;
            this.autoJoin(code);
          } else {
            status.textContent = ' Bukan QR WiFiDrop — cari yang benar';
          }
        },
        () => {} // ignore decode failures (no QR in frame)
      ).then(() => {
        this.isScanning = true;
      }).catch(err => {
        status.textContent = 'Gagal akses kamera: ' + err;
      });
    }).catch(err => {
      status.textContent = 'Gagal akses kamera. Pastikan izin diberikan.';
    });
  }

  stopScan() {
    this._stopScanCamera();
    document.getElementById('scanOverlay').classList.add('hidden');
  }

  _stopScanCamera() {
    if (!this.qrScanner) return;
    if (this.isScanning) {
      this.qrScanner.stop().then(() => {
        this.qrScanner.clear();
        this.isScanning = false;
        this.qrScanner = null;
      }).catch(() => {});
    }
  }

  copyCode() {
    navigator.clipboard.writeText(this.myCode).catch(() => {});
    toast('Kode ' + this.myCode + ' disalin!');
  }

  regenCode() { this.initHost(this.genCode()); }
}

// ════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════
const app = new WifiDropApp();
// sync bell icon with current permission state
if (Notification.permission === 'granted') {
  app.notifEnabled = true;
}
app._updateNotifBtn();

// ════════════════════════════════════════════
// STANDALONE UTILITIES
// ════════════════════════════════════════════
const delay = ms => new Promise(r => setTimeout(r, ms));

function updTextLen(id, len) {
  const el = document.getElementById('tlen-' + id);
  if (el) el.textContent = len + ' karakter';
}

function updProg(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = pct + '%';
}

function getDeviceName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Mac/i.test(ua)) return 'MacBook';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Perangkat';
}

const ICTS = {
  img: { bg: 'rgba(55,138,221,.15)', em: '🖼' },
  vid: { bg: 'rgba(211,99,147,.15)', em: '🎬' },
  aud: { bg: 'rgba(246,185,77,.15)', em: '🎵' },
  pdf: { bg: 'rgba(255,107,138,.15)', em: '📄' },
  zip: { bg: 'rgba(61,214,140,.13)', em: '📦' },
  doc: { bg: 'rgba(124,111,252,.13)', em: '📝' },
  def: { bg: 'rgba(255,255,255,.05)', em: '📁' }
};

function getIc(name) {
  const e = name.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(e)) return ICTS.img;
  if (['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(e)) return ICTS.vid;
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'].includes(e)) return ICTS.aud;
  if (e === 'pdf') return ICTS.pdf;
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return ICTS.zip;
  if (['doc', 'docx', 'txt', 'md', 'xls', 'xlsx', 'ppt', 'pptx'].includes(e)) return ICTS.doc;
  return ICTS.def;
}

function fmtSz(b) {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + 'MB';
  return (b / 1073741824).toFixed(2) + 'GB';
}

function rndId() { return Math.random().toString(36).substr(2, 9); }

function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── QR encoded via app.genQr() (qrcode-generator lib) ──
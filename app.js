/* UI orchestration. Talks to TRIMIX_BLE for transport. */

(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    connectBtn: $('connect-btn'),
    bleWarning: $('ble-warning'),
    status:     $('status'),
    authCard:   $('auth-card'),
    liveCard:   $('live-card'),
    calCard:    $('cal-card'),
    password:   $('password'),
    authBtn:    $('auth-btn'),
    authMsg:    $('auth-msg'),
    calBtn:     $('cal-btn'),
    calSensor:  $('cal-sensor'),
    calRef:     $('cal-ref'),
    calMsg:     $('cal-msg'),
    o2s1: $('o2-s1'), o2s2: $('o2-s2'),
    he:   $('he'),    n2:   $('n2'),
    temp: $('temp'),  hum:  $('hum'),
    press: $('press'), co2: $('co2'), co: $('co'),
  };

  let conn = null;
  let unsubLive = null;
  let unsubResult = null;
  let pendingResult = null;   // { opcode, resolve, reject }

  if (!navigator.bluetooth) {
    els.bleWarning.hidden = false;
    els.connectBtn.disabled = true;
  }

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = 'status ' + cls;
  }

  function showCell(cell, value, decimals = 1, dim = false, uncal = false) {
    if (value === null || value === undefined || Number.isNaN(value)) {
      cell.parentElement.classList.add('invalid');
      cell.parentElement.classList.remove('uncal');
      cell.textContent = '—';
      return;
    }
    cell.parentElement.classList.toggle('invalid', dim);
    cell.parentElement.classList.toggle('uncal', uncal && !dim);
    cell.textContent = value.toFixed(decimals);
  }

  function renderSnapshot(snap) {
    // For each O2/He cell, show "—" if not enabled or not connected; tint
    // amber if enabled+connected but not calibrated (mirrors /api/live UX).
    const renderSensor = (cellEl, s, decimals = 1) => {
      const dim = !s.enabled || !s.connected;
      const uncal = s.enabled && s.connected && !s.calibrated;
      showCell(cellEl, dim ? null : s.pct, decimals, dim, uncal);
    };

    renderSensor(els.o2s1, snap.o2s1);
    renderSensor(els.o2s2, snap.o2s2);
    renderSensor(els.he,   snap.he);
    showCell(els.n2, snap.n2Pct, 1);

    showCell(els.temp,  snap.env.tempC,    1);
    showCell(els.hum,   snap.env.humidity, 0);
    showCell(els.press, snap.env.pressure, 0);
    showCell(els.co2,   snap.env.co2Ppm,   0);
    showCell(els.co,    snap.env.coPpm,    1);
  }

  async function onConnect() {
    setStatus('connecting', 'connecting');
    els.connectBtn.disabled = true;
    try {
      conn = await TRIMIX_BLE.connect();
      conn.device.addEventListener('gattserverdisconnected', onDisconnected);
      setStatus('connected', 'connected');
      els.authCard.hidden = false;
      // Subscribe to live + result immediately — auth gates only writes,
      // not reads/notifies, so we can show live data pre-auth.
      unsubLive = await TRIMIX_BLE.subscribeLive(conn, renderSnapshot);
      els.liveCard.hidden = false;
      unsubResult = await TRIMIX_BLE.subscribeResult(conn, onResult);
    } catch (e) {
      console.error(e);
      setStatus('disconnected', 'disconnected');
      els.connectBtn.disabled = false;
    }
  }

  function onDisconnected() {
    setStatus('disconnected', 'disconnected');
    els.connectBtn.disabled = false;
    els.authCard.hidden = true;
    els.liveCard.hidden = true;
    els.calCard.hidden = true;
    if (unsubLive)   { try { unsubLive();   } catch {} unsubLive = null; }
    if (unsubResult) { try { unsubResult(); } catch {} unsubResult = null; }
    conn = null;
    if (pendingResult) {
      pendingResult.reject(new Error('disconnected'));
      pendingResult = null;
    }
  }

  function onResult(r) {
    if (!pendingResult || pendingResult.opcode !== r.opcode) return;
    const { resolve } = pendingResult;
    pendingResult = null;
    resolve(r);
  }

  function awaitResult(opcode, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      pendingResult = { opcode, resolve, reject };
      setTimeout(() => {
        if (pendingResult && pendingResult.opcode === opcode) {
          pendingResult = null;
          reject(new Error('result timeout'));
        }
      }, timeoutMs);
    });
  }

  async function onAuth() {
    if (!conn) return;
    els.authBtn.disabled = true;
    els.authMsg.className = 'hint';
    els.authMsg.textContent = 'authenticating…';
    try {
      const ok = await TRIMIX_BLE.authenticate(conn, els.password.value);
      if (!ok) {
        els.authMsg.className = 'hint error';
        els.authMsg.textContent = 'wrong password';
        return;
      }
      els.authMsg.className = 'hint success';
      els.authMsg.textContent = 'authenticated';
      els.calCard.hidden = false;
      els.password.value = '';
    } catch (e) {
      console.error(e);
      els.authMsg.className = 'hint error';
      els.authMsg.textContent = e.message || 'auth failed';
    } finally {
      els.authBtn.disabled = false;
    }
  }

  async function onCalibrate() {
    if (!conn || !conn.authenticated) return;
    const sensorIdx = parseInt(els.calSensor.value, 10);
    const refPct    = parseFloat(els.calRef.value);
    if (Number.isNaN(refPct) || refPct <= 0 || refPct > 100) {
      els.calMsg.className = 'hint error';
      els.calMsg.textContent = 'enter a reference 0–100';
      return;
    }
    els.calBtn.disabled = true;
    els.calMsg.className = 'hint';
    els.calMsg.textContent = 'calibrating…';
    try {
      const resultPromise = awaitResult(0x01);
      await TRIMIX_BLE.calibrateO2OnePoint(conn, sensorIdx, refPct);
      const r = await resultPromise;
      if (r.status === 0x00) {
        // Payload: [i16 mv_x10][f32 slope]
        const dv = new DataView(r.payload.buffer, r.payload.byteOffset,
                                r.payload.byteLength);
        const mv = dv.getInt16(0, true) / 10;
        const slope = dv.getFloat32(2, true);
        els.calMsg.className = 'hint success';
        els.calMsg.textContent =
          `OK — mv=${mv.toFixed(2)}, slope=${slope.toFixed(4)}`;
      } else {
        els.calMsg.className = 'hint error';
        els.calMsg.textContent =
          `failed: status=0x${r.status.toString(16)} code=${r.code}`;
      }
    } catch (e) {
      els.calMsg.className = 'hint error';
      els.calMsg.textContent = e.message || 'calibration failed';
    } finally {
      els.calBtn.disabled = false;
    }
  }

  els.connectBtn.addEventListener('click', onConnect);
  els.authBtn.addEventListener('click', onAuth);
  els.calBtn.addEventListener('click', onCalibrate);
  els.password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onAuth();
  });

  /* Switch-to-WiFi modal: each "Logs & History" button opens this with
   * a deep link to the page on the device's WiFi UI. The link itself is
   * what the user taps after switching networks — clicking before
   * switching just leads to a "site can't be reached", which is fine. */
  const wifiPages = {
    advanced: { title: 'Calibration history', path: '/advanced' },
    bottles:  { title: 'Bottles',             path: '/bottles' },
    dives:    { title: 'Dives',               path: '/dives' },
    mixing:   { title: 'Mixing log',          path: '/mixing' },
  };

  const modal      = $('wifi-modal');
  const modalTitle = $('wifi-modal-title');
  const modalLink  = $('wifi-modal-link');
  const modalClose = $('wifi-modal-close');

  function openWifiModal(pageKey) {
    const p = wifiPages[pageKey];
    if (!p) return;
    modalTitle.textContent = p.title + ' (over WiFi)';
    modalLink.href = 'http://192.168.4.1' + p.path;
    modalLink.textContent = 'Open ' + p.title;
    modal.hidden = false;
  }

  document.querySelectorAll('[data-wifi-page]').forEach((btn) => {
    btn.addEventListener('click', () => openWifiModal(btn.dataset.wifiPage));
  });
  modalClose.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });
})();

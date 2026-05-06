/* UI orchestration. Talks to TRIMIX_BLE for transport. */

(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    connectBtn:    $('connect-btn'),
    bleWarning:    $('ble-warning'),
    status:        $('status'),
    authBadge:     $('auth-badge'),
    disconnectBtn: $('disconnect-btn'),
    connectCard:   $('connect-card'),
    authCard:      $('auth-card'),
    liveCard:      $('live-card'),
    calCard:       $('cal-card'),
    password:      $('password'),
    authBtn:       $('auth-btn'),
    authMsg:       $('auth-msg'),
    calBtn:        $('cal-btn'),
    calSensor:     $('cal-sensor'),
    calRef:        $('cal-ref'),
    calMsg:        $('cal-msg'),
    o2s1: $('o2-s1'), o2s2: $('o2-s2'),
    he:   $('he'),
    temp: $('temp'),  hum:  $('hum'),
    press: $('press'), co2: $('co2'), co: $('co'),
  };

  let conn = null;
  let unsubLive = null;
  let unsubResult = null;
  let pendingResult = null;        // { opcode, resolve, reject, timer }
  let savedDevice = null;          // kept for auto-reconnect
  let savedPassword = null;        // in-memory only — re-auth on reconnect
  let userInitiatedDisconnect = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;

  /* Stop retrying after this many attempts (≈4 minutes of backoff before
   * the cap, plus 12 s per attempt at the cap). After that the user has
   * to tap Connect manually — keeps battery sane if the analyzer is off. */
  const MAX_RECONNECT_ATTEMPTS = 20;

  if (!navigator.bluetooth) {
    els.bleWarning.hidden = false;
    els.connectBtn.disabled = true;
  }

  /*-----------------------------------------------------------------------*/
  /* UI helpers                                                            */
  /*-----------------------------------------------------------------------*/

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = 'badge status ' + cls;
  }

  function setAuthBadge(visible) {
    els.authBadge.hidden = !visible;
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
    const renderSensor = (cellEl, s, decimals = 1) => {
      const dim   = !s.enabled || !s.connected;
      const uncal = s.enabled && s.connected && !s.calibrated;
      showCell(cellEl, dim ? null : s.pct, decimals, dim, uncal);
    };

    renderSensor(els.o2s1, snap.o2s1);
    renderSensor(els.o2s2, snap.o2s2);
    renderSensor(els.he,   snap.he);

    showCell(els.temp,  snap.env.tempC,    1);
    showCell(els.hum,   snap.env.humidity, 0);
    showCell(els.press, snap.env.pressure, 0);
    showCell(els.co2,   snap.env.co2Ppm,   0);
    showCell(els.co,    snap.env.coPpm,    1);
  }

  /*-----------------------------------------------------------------------*/
  /* Result NOTIFY handling                                                 */
  /*-----------------------------------------------------------------------*/

  function onResult(r) {
    console.log('[ble] result', r);
    if (!pendingResult || pendingResult.opcode !== r.opcode) return;
    const { resolve, timer } = pendingResult;
    if (timer) clearTimeout(timer);
    pendingResult = null;
    resolve(r);
  }

  function awaitResult(opcode, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingResult && pendingResult.opcode === opcode) {
          pendingResult = null;
          reject(new Error(
            'no result NOTIFY received within ' + timeoutMs + ' ms — ' +
            'check device serial log or that result subscription is active'));
        }
      }, timeoutMs);
      pendingResult = { opcode, resolve, reject, timer };
    });
  }

  /*-----------------------------------------------------------------------*/
  /* Connect / Reconnect / Disconnect                                       */
  /*-----------------------------------------------------------------------*/

  async function setupConnection(device) {
    conn = await TRIMIX_BLE.connect(device);
    savedDevice = conn.device;
    conn.device.addEventListener('gattserverdisconnected', onDisconnected);

    unsubLive   = await TRIMIX_BLE.subscribeLive(conn, renderSnapshot);
    unsubResult = await TRIMIX_BLE.subscribeResult(conn, onResult);
    setStatus('connected', 'connected');
    els.disconnectBtn.hidden = false;
    els.liveCard.hidden = false;
  }

  async function onConnect() {
    setStatus('connecting', 'connecting');
    els.connectBtn.disabled = true;
    userInitiatedDisconnect = false;
    try {
      await setupConnection(null);  // null → user-prompted picker
      els.authCard.hidden = false;
    } catch (e) {
      console.error(e);
      setStatus('disconnected', 'disconnected');
      els.connectBtn.disabled = false;
    }
  }

  function onDisconnected() {
    console.log('[ble] disconnected');
    setStatus('disconnected', 'disconnected');
    setAuthBadge(false);
    if (conn) conn.authenticated = false;

    if (unsubLive)   { try { unsubLive();   } catch {} unsubLive = null; }
    if (unsubResult) { try { unsubResult(); } catch {} unsubResult = null; }
    if (pendingResult) {
      pendingResult.reject(new Error('disconnected'));
      pendingResult = null;
    }

    /* Hide the calibration card on every disconnect — even if we re-auth
     * silently in a moment, leaving it visible while `conn.authenticated`
     * is false confuses the user (Calibrate button looks live but bails
     * with "authenticate first"). It comes back when re-auth succeeds. */
    els.calCard.hidden = true;

    if (userInitiatedDisconnect || !savedDevice) {
      // Manual disconnect — full UI reset, don't auto-reconnect.
      els.connectBtn.disabled = false;
      els.connectCard.hidden = false;
      els.authCard.hidden = true;
      els.liveCard.hidden = true;
      els.disconnectBtn.hidden = true;
      conn = null;
      savedDevice = null;
      savedPassword = null;
      reconnectAttempt = 0;
      return;
    }

    // Auto-reconnect path
    scheduleReconnect();
  }

  function giveUpReconnecting(reason) {
    console.warn('[ble] giving up:', reason);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setStatus('disconnected', 'disconnected');
    /* Surface the manual Connect button again. Keep savedDevice null so
     * the next user click goes through the standard requestDevice() chooser
     * — safer than auto-reconnecting to a possibly-gone device. */
    els.connectBtn.disabled = false;
    els.connectCard.hidden = false;
    els.authCard.hidden = true;
    els.liveCard.hidden = true;
    els.calCard.hidden  = true;
    els.disconnectBtn.hidden = true;
    conn = null;
    savedDevice = null;
    savedPassword = null;
    reconnectAttempt = 0;
  }

  function scheduleReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      giveUpReconnecting('max attempts reached');
      return;
    }
    const delay = Math.min(1500 * Math.pow(1.4, reconnectAttempt), 12000);
    reconnectAttempt++;
    setStatus(`reconnecting (${reconnectAttempt})`, 'connecting');
    console.log('[ble] reconnect attempt', reconnectAttempt, 'in', delay, 'ms');
    reconnectTimer = setTimeout(tryReconnect, delay);
  }

  /**
   * If the user clicked Disconnect while we were awaiting a connect or
   * auth step, drop the freshly-established link instead of leaving a
   * zombie session that the UI thinks is gone. Returns true if we bailed.
   */
  function bailIfUserCancelled() {
    if (!userInitiatedDisconnect) return false;
    if (conn && conn.server && conn.server.connected) {
      try { conn.server.disconnect(); } catch {}
    }
    return true;
  }

  async function tryReconnect() {
    if (!savedDevice || userInitiatedDisconnect) return;
    try {
      await setupConnection(savedDevice);
      if (bailIfUserCancelled()) return;
      reconnectAttempt = 0;
      // If we had auth before, transparently re-auth using the cached password.
      if (savedPassword) {
        const ok = await TRIMIX_BLE.authenticate(conn, savedPassword);
        if (bailIfUserCancelled()) return;
        if (ok) {
          conn.authenticated = true;
          setAuthBadge(true);
          els.authCard.hidden = true;
          els.calCard.hidden = false;
        } else {
          // Password may have changed — surface the auth card again.
          savedPassword = null;
          els.authCard.hidden = false;
        }
      } else {
        // No cached password — show the auth card so user can unlock.
        els.authCard.hidden = false;
      }
    } catch (e) {
      console.warn('[ble] reconnect failed:', e.message);
      if (!userInitiatedDisconnect) scheduleReconnect();
    }
  }

  function onUserDisconnect() {
    userInitiatedDisconnect = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (conn && conn.server && conn.server.connected) {
      try { conn.server.disconnect(); } catch {}
    } else {
      onDisconnected();   // fire cleanup if already gone
    }
  }

  /*-----------------------------------------------------------------------*/
  /* Auth                                                                   */
  /*-----------------------------------------------------------------------*/

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
      // Success — collapse the auth card, badge in header, cache for reconnect.
      savedPassword = els.password.value;
      els.password.value = '';
      els.authMsg.textContent = '';
      els.authCard.hidden = true;
      els.calCard.hidden  = false;
      setAuthBadge(true);
    } catch (e) {
      console.error(e);
      els.authMsg.className = 'hint error';
      els.authMsg.textContent = e.message || 'auth failed';
    } finally {
      els.authBtn.disabled = false;
    }
  }

  /*-----------------------------------------------------------------------*/
  /* Calibration                                                            */
  /*-----------------------------------------------------------------------*/

  function statusName(code) {
    switch (code) {
      case 0x00: return 'OK';
      case 0x01: return 'malformed payload';
      case 0x02: return 'not authenticated';
      case 0x03: return 'sensor not found';
      case 0x04: return 'sensor not connected or no valid reading';
      case 0x05: return 'value out of range';
      case 0xFF: return 'firmware reported failure';
      default:   return 'unknown status 0x' + code.toString(16);
    }
  }

  async function onCalibrate() {
    if (!conn) {
      els.calMsg.className = 'hint error';
      els.calMsg.textContent = 'not connected';
      return;
    }
    if (!conn.authenticated) {
      els.calMsg.className = 'hint error';
      els.calMsg.textContent = 'authenticate first (above)';
      return;
    }
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
      console.log('[ble] calibrate sensor=' + sensorIdx + ' ref=' + refPct);
      const resultPromise = awaitResult(0x01);
      await TRIMIX_BLE.calibrateO2OnePoint(conn, sensorIdx, refPct);
      console.log('[ble] write done — waiting for result');
      const r = await resultPromise;
      if (r.status === 0x00) {
        const dv = new DataView(r.payload.buffer, r.payload.byteOffset,
                                r.payload.byteLength);
        const mv    = dv.getInt16(0, true) / 10;
        const slope = dv.getFloat32(2, true);
        els.calMsg.className = 'hint success';
        els.calMsg.textContent =
          `OK — mv=${mv.toFixed(2)}, slope=${slope.toFixed(4)}`;
      } else {
        els.calMsg.className = 'hint error';
        els.calMsg.textContent =
          'failed: ' + statusName(r.status) +
          (r.code ? ' (code=' + r.code + ')' : '');
      }
    } catch (e) {
      console.error('[ble] calibrate error:', e);
      els.calMsg.className = 'hint error';
      els.calMsg.textContent = e.message || 'calibration failed';
    } finally {
      els.calBtn.disabled = false;
    }
  }

  /*-----------------------------------------------------------------------*/
  /* Switch-to-WiFi modal                                                   */
  /*-----------------------------------------------------------------------*/

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

  /*-----------------------------------------------------------------------*/
  /* Wiring                                                                 */
  /*-----------------------------------------------------------------------*/

  /*-----------------------------------------------------------------------*/
  /* Auto-connect on page load (silent, no chooser)                         */
  /*-----------------------------------------------------------------------*/
  /* If this origin already has permission to a Trimix device, reconnect
   * silently without showing the picker. Falls back to the manual button
   * if no permission exists, the device is out of range, or the API
   * isn't available. */
  async function tryAutoConnect() {
    if (!navigator.bluetooth) return;
    const device = await TRIMIX_BLE.getKnownDevice();
    if (!device) return;
    /* Pre-seed savedDevice so the retry path works if this initial attempt
     * fails (analyzer briefly off, out of range, etc.). */
    savedDevice = device;
    setStatus('auto-connecting…', 'connecting');
    els.connectBtn.disabled = true;
    userInitiatedDisconnect = false;
    try {
      await setupConnection(device);
      if (bailIfUserCancelled()) return;
      els.authCard.hidden = false;  // user still types password each visit
    } catch (e) {
      console.warn('[ble] auto-connect failed:', e.message);
      /* Schedule a backoff retry — same machinery as gattserverdisconnected
       * recovery, so the user just sees "reconnecting (n)" and gets picked
       * up automatically once the analyzer comes back. */
      if (!userInitiatedDisconnect) scheduleReconnect();
    }
  }

  els.connectBtn.addEventListener('click', onConnect);
  els.disconnectBtn.addEventListener('click', onUserDisconnect);
  els.authBtn.addEventListener('click', onAuth);
  els.calBtn.addEventListener('click', onCalibrate);
  els.password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onAuth();
  });
  document.querySelectorAll('[data-wifi-page]').forEach((btn) => {
    btn.addEventListener('click', () => openWifiModal(btn.dataset.wifiPage));
  });
  modalClose.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });

  /* Kick off silent auto-connect once the rest of the page is ready. */
  tryAutoConnect();
})();

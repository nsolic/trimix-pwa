/**
 * Web Bluetooth transport for the Trimix Analyzer.
 *
 * Mirrors the GATT layout in main/ble/ble_uuids.h and the binary snapshot
 * in main/ble/ble_live.h. UUIDs and byte offsets must stay in sync with
 * the firmware.
 */
const TRIMIX_BLE = (() => {
  const SVC        = 'd7c3c2a1-0001-4000-a000-1e2d3f4b5a6c';
  const LIVE       = 'd7c3c2a1-0002-4000-a000-1e2d3f4b5a6c';
  const AUTH       = 'd7c3c2a1-0003-4000-a000-1e2d3f4b5a6c';
  const CMD        = 'd7c3c2a1-0004-4000-a000-1e2d3f4b5a6c';
  const CMD_RESULT = 'd7c3c2a1-0005-4000-a000-1e2d3f4b5a6c';

  const LIVE_VERSION = 1;

  /** Decode the 32-byte snapshot. Returns plain JS object. */
  function parseSnapshot(dv) {
    if (dv.byteLength < 32) throw new Error('snapshot too short');
    const version = dv.getUint8(0);
    if (version !== LIVE_VERSION) {
      console.warn('snapshot version', version, 'expected', LIVE_VERSION);
    }

    const flags  = dv.getUint8(1);
    const enable = dv.getUint8(2);
    const conn   = dv.getUint8(3);

    const i16 = (off) => dv.getInt16(off, true);
    const u16 = (off) => dv.getUint16(off, true);
    const u8  = (off) => dv.getUint8(off);

    const tempRaw = i16(18);
    const humRaw  = u8(20);
    const pressRaw = u16(22);
    const co2Raw  = u16(24);
    const coRaw   = u16(26);

    return {
      version,
      mixerMode:           !!(flags & 0x01),
      anyDisconnected:     !!(flags & 0x02),
      o2s1: {
        enabled:    !!(enable & 0x01),
        calibrated: !!(enable & 0x08),
        connected:  !!(conn & 0x01),
        pct: i16(4) / 100.0,
        mv:  i16(6) / 10.0,
      },
      o2s2: {
        enabled:    !!(enable & 0x02),
        calibrated: !!(enable & 0x10),
        connected:  !!(conn & 0x02),
        pct: i16(8) / 100.0,
        mv:  i16(10) / 10.0,
      },
      he: {
        enabled:    !!(enable & 0x04),
        calibrated: !!(enable & 0x20),
        connected:  !!(conn & 0x04),
        pct: i16(12) / 100.0,
        mv:  i16(14) / 10.0,
      },
      n2Pct: i16(16) / 100.0,
      env: {
        tempC:    tempRaw === -32768 ? null : tempRaw / 10.0,
        humidity: humRaw === 0xFF   ? null : humRaw,
        pressure: pressRaw === 0    ? null : pressRaw,
        co2Ppm:   co2Raw === 0      ? null : co2Raw,
        coPpm:    coRaw === 0       ? null : coRaw / 10.0,
      },
      timestampMs: dv.getUint32(28, true),
    };
  }

  /** Compute SHA-256(SHA256(password) ‖ nonce) — matches firmware. */
  async function challengeResponse(password, nonce) {
    const enc = new TextEncoder();
    const pwdHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', enc.encode(password))
    );
    const combined = new Uint8Array(pwdHash.length + nonce.length);
    combined.set(pwdHash, 0);
    combined.set(nonce, pwdHash.length);
    return new Uint8Array(
      await crypto.subtle.digest('SHA-256', combined)
    );
  }

  /**
   * Connect to a Trimix device. Pass an existing device to skip the chooser
   * (used by auto-reconnect — `device.gatt.connect()` does not require a
   * fresh user gesture once we already have a device reference).
   */
  async function connect(existingDevice = null) {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth not supported');
    }
    const device = existingDevice || await navigator.bluetooth.requestDevice({
      filters: [{ name: 'Trimix-Analyzer' }],
      optionalServices: [SVC],
    });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SVC);
    const live   = await service.getCharacteristic(LIVE);
    const auth   = await service.getCharacteristic(AUTH);
    const cmd    = await service.getCharacteristic(CMD);
    const result = await service.getCharacteristic(CMD_RESULT);

    return {
      device,
      server,
      service,
      live,
      auth,
      cmd,
      result,
      authenticated: false,
    };
  }

  /**
   * Run the challenge-response auth exchange.
   * @returns true on success, throws on transport errors.
   *          The Web Bluetooth API rejects writeValue() with a
   *          GATTOperationError when the firmware returns
   *          BLE_ATT_ERR_INSUFFICIENT_AUTHEN — we treat that as a wrong
   *          password and return false.
   */
  async function authenticate(conn, password) {
    const nonceBuf = await conn.auth.readValue();
    const nonce = new Uint8Array(nonceBuf.buffer);
    const response = await challengeResponse(password, nonce);
    try {
      await conn.auth.writeValueWithResponse(response);
    } catch (e) {
      // Most browsers surface ATT errors as a generic NetworkError /
      // GATTOperationError without an error code. Treat any rejection
      // here as auth failure rather than a transport problem.
      console.warn('auth write rejected:', e);
      return false;
    }
    conn.authenticated = true;
    return true;
  }

  /** Subscribe to live notifications. onSnapshot receives a parsed object. */
  async function subscribeLive(conn, onSnapshot) {
    const handler = (e) => onSnapshot(parseSnapshot(e.target.value));
    conn.live.addEventListener('characteristicvaluechanged', handler);
    await conn.live.startNotifications();
    return () => conn.live.removeEventListener(
      'characteristicvaluechanged', handler);
  }

  /** Subscribe to command results. */
  async function subscribeResult(conn, onResult) {
    const handler = (e) => {
      const dv = e.target.value;
      if (dv.byteLength < 3) return;
      onResult({
        opcode: dv.getUint8(0),
        status: dv.getUint8(1),
        code:   dv.getUint8(2),
        payload: new Uint8Array(dv.buffer, dv.byteOffset + 3, dv.byteLength - 3),
      });
    };
    conn.result.addEventListener('characteristicvaluechanged', handler);
    await conn.result.startNotifications();
    return () => conn.result.removeEventListener(
      'characteristicvaluechanged', handler);
  }

  /** Send the O2 1-point cal opcode. Args validated by firmware too. */
  async function calibrateO2OnePoint(conn, sensorIdx, refPct) {
    const refX100 = Math.round(refPct * 100);
    const buf = new Uint8Array(4);
    buf[0] = 0x01;                  // opcode
    buf[1] = sensorIdx & 0xFF;
    buf[2] = refX100 & 0xFF;
    buf[3] = (refX100 >> 8) & 0xFF;
    await conn.cmd.writeValueWithResponse(buf);
  }

  return {
    UUIDs: { SVC, LIVE, AUTH, CMD, CMD_RESULT },
    connect,
    authenticate,
    subscribeLive,
    subscribeResult,
    calibrateO2OnePoint,
  };
})();

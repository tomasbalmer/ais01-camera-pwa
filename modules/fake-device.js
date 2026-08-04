/*
 * A simulated Dragino v1.3 + BG95, for the half of provisioning that a real
 * unit cannot test.
 *
 * A hardware run exercises the happy path. It does not exercise the paths you
 * hope never happen — passthrough entering on the STM32 side but not the modem,
 * ATE0 refused, a stream that loses bytes, a retry after a bad checksum. Those
 * are where a bug costs the most and is least likely to be found by plugging
 * something in.
 *
 * The simulation is faithful where it matters: it implements the passthrough's
 * CR→CRLF expansion and computes the checksum over what it *stored*, exactly
 * like the modem. If `canonicalBytes` or `wireParts` were wrong, this fake
 * would echo a different pair and the test would fail — it is not agreeing with
 * our arithmetic, it is re-deriving it from the other side.
 *
 * Follows the repo's existing `?mock` convention (see modules/mock.js): loaded
 * only on demand, never part of a production path.
 */

import { qfuplChecksum } from './certmod.js';

/*
 * `faults` injects the failures worth rehearsing:
 *   noRdy         firmware prints entry, BG95 never says RDY
 *   refuseAte0    echo cannot be turned off — must refuse to stream secrets
 *   dropPart      1-based part index to swallow, simulating a lost BLE write
 *   healAfter     attempt number from which faults stop, to exercise recovery
 *   noExit        passthrough never confirms the exit
 */
export function makeFakeDevice(faults = {}, onEmit = null) {
    const emitted = [];
    const received = [];   /* what we were told, so tests can assert on it */
    let listeners = [];
    let inCertmod = false;
    let echoOff = false;
    let upload = null;          /* { name, declaredSize, stored: [] } */
    let attempts = {};          /* per filename, to drive healAfter */
    let partIndex = 0;

    const emit = line => {
        emitted.push(line);
        listeners.forEach(l => l.lines.push(line));
        /* When the page drives this, its terminal is the other subscriber —
         * the same path a real notification takes, so the display and the
         * redaction filter are exercised too. */
        if (onEmit) onEmit(line);
    };

    const healed = name => faults.healAfter && (attempts[name] || 0) >= faults.healAfter;

    function onLine(text) {
        const cmd = text.trim();
        received.push(cmd);

        if (cmd === 'AT+CERTMOD') {
            inCertmod = !inCertmod;
            if (inCertmod) {
                emit('Enter certificate mode');
                if (!faults.noRdy) emit('RDY');
            } else if (!faults.noExit) {
                emit('Exit certificate mode');
            }
            return;
        }
        if (cmd === 'ATE0') {
            if (faults.refuseAte0) emit('ERROR');
            else { echoOff = true; emit('OK'); }
            return;
        }
        if (cmd.startsWith('AT+QFDEL=')) {
            /* The real modem answers ERROR when the file is absent, and the
             * caller must treat that as fine. Alternating proves it does. */
            emit(Math.random() < 0.5 ? 'OK' : 'ERROR');
            return;
        }
        if (cmd.startsWith('AT+QFUPL=')) {
            const m = /AT\+QFUPL="([^"]+)",(\d+)/.exec(cmd);
            if (!m) { emit('ERROR'); return; }
            const name = m[1];
            attempts[name] = (attempts[name] || 0) + 1;
            upload = { name, declaredSize: parseInt(m[2], 10), stored: [] };
            partIndex = 0;
            emit('CONNECT');
            return;
        }
        emit('OK');
    }

    /*
     * The passthrough contract, implemented from the modem's side: each console
     * line is truncated at its first CR/LF and CRLF is appended unconditionally.
     * So a part sent as `<line>\r` is stored as `<line>\r\n`.
     */
    function onRaw(bytes) {
        if (!upload) return;
        partIndex++;

        const dropping = faults.dropPart === partIndex && !healed(upload.name);
        if (!dropping) {
            const text = new TextDecoder().decode(bytes);
            const line = text.split(/[\r\n]/)[0];
            for (const b of new TextEncoder().encode(line + '\r\n')) {
                upload.stored.push(b);
            }
        }

        if (upload.stored.length >= upload.declaredSize) {
            const stored = new Uint8Array(upload.stored);
            emit(`+QFUPL: ${stored.length},` +
                 qfuplChecksum(stored).toString(16).toUpperCase().padStart(4, '0'));
            emit('OK');
            upload = null;
        }
    }

    const io = {
        /* Collapsed but not zero: replies must still land after the send that
         * caused them, which is the ordering the real code depends on. */
        sleep: () => Promise.resolve(),
        floorMs: 0,
        listen(_ms) {
            const l = { lines: [] };
            listeners.push(l);
            return new Promise(resolve => setTimeout(() => {
                listeners = listeners.filter(x => x !== l);
                resolve(l.lines);
            }, 5));
        },
        async send(text) { onLine(text); },
        async sendRaw(bytes) { onRaw(bytes); },
        log() {},
    };

    return {
        io,
        transcript: emitted,
        received,
        state: () => ({ inCertmod, echoOff, attempts }),
    };
}

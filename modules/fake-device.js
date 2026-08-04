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
 *   startInside   unit is ALREADY in passthrough, so the first toggle exits
 */
export function makeFakeDevice(faults = {}, onEmit = null) {
    const emitted = [];
    const received = [];   /* what we were told, so tests can assert on it */
    let listeners = [];
    let inCertmod = !!faults.startInside;
    let modemUp = true;
    /* The firmware's own NB init owns the BG95 until it is done. Entering
     * passthrough during it gets the entry printed and no RDY — the modem is
     * mid-conversation with someone else. `Signal Strength:` is the heartbeat
     * that says init is over. */
    let initBusy = !!faults.initBusy;
    let echoOff = false;
    let upload = null;          /* { name, declaredSize, stored: [] } */
    let attempts = {};          /* per filename, to drive healAfter */
    let partIndex = 0;

    const emit = line => {
        emitted.push(line);
        /* A copy, because `onLine` unregisters mid-delivery — the whole point
         * of this simulator is to let that happen the way it happens live. */
        for (const l of [...listeners]) {
            if (!listeners.includes(l)) continue;
            l.lines.push(line);
            if (l.onLine) l.onLine(line);
        }
        /* When the page drives this, its terminal is the other subscriber —
         * the same path a real notification takes, so the display and the
         * redaction filter are exercised too. */
        if (onEmit) onEmit(line);
    };

    const healed = name => faults.healAfter && (attempts[name] || 0) >= faults.healAfter;

    /* Init finishes on its own clock, not on anything the app sends — so the
     * only way to be past it is to have waited for the beat that says so. */
    if (initBusy) setTimeout(() => { initBusy = false; emit('Signal Strength:0'); }, 1);

    function onLine(text) {
        const cmd = text.trim();
        received.push(cmd);

        /* A modem with echo on sends the command back before answering it.
         * That is what makes `OK` after `ATE0` worthless as proof, and what
         * put certificate body text on a phone screen on 2026-08-04. */
        if (!echoOff && inCertmod) emit(cmd);

        if (cmd === 'AT') { emit('OK'); return; }

        if (cmd === 'AT+CERTMOD') {
            inCertmod = !inCertmod;
            /* The modem reboots on the way in, so it comes back at its ATE1
             * default and whatever the firmware silenced earlier is undone. */
            if (inCertmod) echoOff = false;
            if (inCertmod) {
                /* Observed live 2026-08-04, and the reason the three lines are
                 * emitted together: they arrive in ONE batch, so a collector
                 * that resolves on the first of them loses the other two. */
                emit('Enter certificate mode');
                emit('OK');
                /* Entering powers the BG95 back up. The earlier reading — that
                 * a re-entry lands on a dead modem — came from `Signal
                 * Strength:0`, which is a modem that just booted and has no
                 * network yet, not a modem that is absent. RDY says it is
                 * there, and RDY is what arrived. */
                if (!faults.deadModem) modemUp = true;
                if (!faults.noRdy && modemUp && !initBusy) emit('RDY');
            } else if (!faults.noExit) {
                emit('Exit certificate mode');
                emit('OK');
                /* Leaving passthrough powers the BG95 down. Survivable — the
                 * next entry brings it back — but never free. */
                emit('NORMAL POWER DOWN');
                modemUp = false;
            }
            return;
        }
        if (cmd === 'ATE0') {
            if (faults.refuseAte0) { emit('ERROR'); return; }
            /* Observed live: `OK` came back and every later command was still
             * echoed. An answer is not an effect, and only the probe can tell
             * them apart. */
            if (!faults.ate0Lies) echoOff = true;
            emit('OK');
            return;
        }
        if (cmd.startsWith('AT+QFLST')) {
            /* The firmware can drop out of certificate mode by itself — it did
             * on 2026-08-04 when it powered the NB module down. After that the
             * exit toggle goes the other way. */
            if (faults.exitFindsItOut) inCertmod = false;
            emit('OK');
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
        /*
         * This must be the app's `until`, not a window that ignores the
         * pattern — which is what it used to be, and why ten passing scenarios
         * said nothing about the bug that actually stopped a cert write on
         * 2026-08-04.
         *
         * The behaviour that matters is the unregister: the collector leaves
         * the set SYNCHRONOUSLY on the matching line, while the rest of the
         * batch is still being delivered. Whatever the device says after the
         * marker and before the next collector registers is delivered to
         * nobody. A simulator that collects everything for a fixed window
         * cannot lose a line, so it cannot reproduce the one failure this
         * conversation is most exposed to.
         */
        until(pattern, ms) {
            const l = { lines: [] };
            listeners.push(l);
            return new Promise(resolve => {
                l.onLine = line => {
                    if (!pattern.test(line)) return;
                    listeners = listeners.filter(x => x !== l);
                    resolve(l.lines);
                };
                /* The ceiling is collapsed, like every other delay here: what
                 * is being rehearsed is the ORDER lines arrive in, never how
                 * long the code is willing to wait for them. */
                setTimeout(() => {
                    listeners = listeners.filter(x => x !== l);
                    resolve(l.lines);
                }, Math.min(ms, 5));
            });
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

import { crc16 } from './himax-ota.js';

export function makeFakeLoader({
    baud = 921600, appBaud = baud, startInApp = false, silent = false,
    burnError = 0, busyPolls = 0, finalError = 0, ignoredIntoupg = 0,
} = {}) {
    let currentBaud = null;
    let inLoader = !startInApp;
    let rebooted = false;
    let rx = [];
    let out = [];
    let pending = null;
    let busy = 0;
    let error = 0;
    let current = null;
    let ignored = ignoredIntoupg;
    const events = [];
    const parts = [];

    const activeBaud = () => (inLoader ? baud : appBaud);

    const reply = (status, err = 0) => {
        const v = ((status << 16) | err) >>> 0;
        const body = [0xC0, 0x50, 0x05, 0x00, 0x04, v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, v >>> 24];
        const c = crc16(body);
        const payload = [...body, c & 0xFF, c >>> 8];
        out.push(0xC0, 0x5A, 0x01, payload.length, 0, 0, 0, ...payload);
    };

    const handle = (cmd, sub, data) => {
        events.push({ cmd, sub, length: data ? data.length : 0 });
        if (cmd === 0x50 && sub === 0x05) {
            if (silent) return;
            if (!inLoader) return reply(0);
            if (busy > 0) { busy--; return reply(8); }
            return reply(1, error);
        }
        if (cmd === 0x50 && sub === 0x07 && !inLoader) {
            if (ignored > 0) ignored--;
            else inLoader = true;
        }
        if (cmd === 0x50 && sub === 0x06) rebooted = true;
        if (cmd === 0x51 && sub === 0x02) { current = { entry: Array.from(data), bytes: [], ended: false }; parts.push(current); }
        if (cmd === 0x51 && sub === 0x03) current.bytes.push(...data);
        if (cmd === 0x51 && sub === 0x04) {
            current.ended = true;
            busy = busyPolls;
            error = burnError;
            if (parts.length && finalError) error = finalError;
        }
    };

    const process = () => {
        for (;;) {
            if (pending) {
                if (rx.length < pending.length + 2) return;
                const frame = rx.splice(0, pending.length + 2);
                const data = frame.slice(0, pending.length);
                const crc = frame[pending.length] | (frame[pending.length + 1] << 8);
                const { cmd, sub } = pending;
                pending = null;
                if (crc !== crc16(data)) { events.push({ bad: 'data crc', cmd, sub }); continue; }
                handle(cmd, sub, data);
                continue;
            }
            if (rx.length < 7) return;
            const f = rx.splice(0, 7);
            const crc = f[5] | (f[6] << 8);
            if (f[0] !== 0xC0 || crc !== crc16(f.slice(1, 5))) { events.push({ bad: 'command frame', bytes: f }); continue; }
            const length = f[3] | (f[4] << 8);
            if (length) pending = { cmd: f[1], sub: f[2], length };
            else handle(f[1], f[2], null);
        }
    };

    const link = {
        async setBaud(b) { currentBaud = b; },
        async purge() { const stale = Uint8Array.from(out); out = []; return stale; },
        async write(bytes) {
            if (currentBaud !== activeBaud()) return;
            for (const b of bytes) rx.push(b);
            process();
        },
        async read(n) { return Uint8Array.from(out.splice(0, n)); },
    };

    return {
        link, events, parts,
        get rebooted() { return rebooted; },
        get inLoader() { return inLoader; },
    };
}

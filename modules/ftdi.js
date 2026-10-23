import {
    FTDI_VID, FTDI_PID, FTDI_BAUD,
    SIO_RESET, SIO_SET_MODEM_CTRL, SIO_SET_FLOW_CTRL,
    SIO_SET_BAUD_RATE, SIO_SET_DATA, SIO_SET_LATENCY_TIMER,
    FTDI_BASE_CLOCK, FTDI_FRAC_CODES, FTDI_FRAC_SHIFT,
    FTDI_DATA_8N1, FTDI_LATENCY_MS,
    FTDI_DTR_ON, FTDI_RTS_ON,
    FTDI_PURGE_RX, FTDI_PURGE_TX,
    FTDI_HEADER_SIZE, FTDI_DEFAULT_PACKET_SIZE, USB_TRANSFER_SIZE,
} from './constants.js';
import { state } from './state.js';
import { dom, log } from './ui.js';
import { sendCommand } from './protocol.js';

// === FTDI baud rate divisor (Spec Section 1) ===
function ftdiBaudDivisor(baudRate) {
    if (baudRate >= FTDI_BASE_CLOCK) return { wValue: 0, wIndex: 0 };
    const divisor8 = Math.round((FTDI_BASE_CLOCK * 8) / baudRate);
    const intPart = Math.floor(divisor8 / 8);
    const fracPart = divisor8 % 8;
    const encoded = intPart | (FTDI_FRAC_CODES[fracPart] << FTDI_FRAC_SHIFT);
    const actualBaud = Math.round(FTDI_BASE_CLOCK / (intPart + fracPart / 8));
    log(`Baud: target=${baudRate} actual=${actualBaud} (${((actualBaud - baudRate) / baudRate * 100).toFixed(2)}% err)`);
    return { wValue: encoded & 0xFFFF, wIndex: (encoded >> 16) & 0xFFFF };
}

// === Connect to FTDI + initialize sensor ===
export async function connectDevice() {
    try {
        log('Requesting USB device...');
        state.device = await navigator.usb.requestDevice({
            filters: [{ vendorId: FTDI_VID, productId: FTDI_PID }]
        });
        log(`Device: ${state.device.productName || 'FTDI'}`);

        await state.device.open();
        if (state.device.configuration === null) await state.device.selectConfiguration(1);
        await state.device.claimInterface(0);

        const idx = 0;

        // 1. FT_ResetDevice
        await state.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_RESET, value: 0, index: idx });
        log('FTDI: reset OK');

        // 2. FT_SetBaudRate(921600)
        const { wValue, wIndex } = ftdiBaudDivisor(FTDI_BAUD);
        await state.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_BAUD_RATE, value: wValue, index: wIndex });

        // 3. FT_SetDataCharacteristics(8, 0, 0) -> 8N1
        await state.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_DATA, value: FTDI_DATA_8N1, index: idx });

        // 4. FT_SetFlowControl(NONE)
        await state.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_FLOW_CTRL, value: 0, index: idx });

        // 5. FT_Purge(RX | TX)
        await state.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_RESET, value: FTDI_PURGE_RX, index: idx });
        await state.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_RESET, value: FTDI_PURGE_TX, index: idx });
        log('FTDI: purge RX+TX OK');

        // 6. FT_SetLatencyTimer(1)
        await state.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_LATENCY_TIMER, value: FTDI_LATENCY_MS, index: idx });
        log(`FTDI: latency=${FTDI_LATENCY_MS}ms`);

        // 7. FT_SetDtr
        await state.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_MODEM_CTRL, value: FTDI_DTR_ON, index: idx });

        // 8. FT_SetRts
        await state.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_MODEM_CTRL, value: FTDI_RTS_ON, index: idx });
        log('FTDI: DTR=1 RTS=1');

        log('FTDI configured (D2XX sequence)');

        // Find endpoints
        const alt = state.device.configuration.interfaces[0].alternates[0];
        const epIn = alt.endpoints.find(e => e.direction === 'in');
        const epOut = alt.endpoints.find(e => e.direction === 'out');
        state.epOutNum = epOut ? epOut.endpointNumber : null;
        log(`Endpoints: IN=${epIn?.endpointNumber} OUT=${state.epOutNum}`);

        if (!state.epOutNum) log('WARNING: No OUT endpoint');

        // Initialize sensor: Start only — SHOW_FULL_IMAGE sent after skeleton
        await sendCommand('START');
        log('Sensor initialized');

        return epIn;

    } catch (err) {
        if (err.name === 'NotFoundError') {
            dom.message.innerHTML = 'No FTDI device selected.';
        } else {
            dom.message.innerHTML = `Error: ${err.message}`;
        }
        dom.message.className = 'error';
        log(`Error: ${err.message}`);
        return null;
    }
}

export async function openFtdi(baudRate = FTDI_BAUD) {
    log('Requesting USB device...');
    const device = await navigator.usb.requestDevice({
        filters: [{ vendorId: FTDI_VID, productId: FTDI_PID }]
    });
    log(`Device: ${device.productName || 'FTDI'}`);

    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(0);

    const vendor = (request, value, index = 0) =>
        device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request, value, index });
    await vendor(SIO_RESET, 0);
    await setFtdiBaud(device, baudRate);
    await vendor(SIO_SET_DATA, FTDI_DATA_8N1);
    await vendor(SIO_SET_FLOW_CTRL, 0);
    await vendor(SIO_RESET, FTDI_PURGE_RX);
    await vendor(SIO_RESET, FTDI_PURGE_TX);
    await vendor(SIO_SET_LATENCY_TIMER, FTDI_LATENCY_MS);
    await vendor(SIO_SET_MODEM_CTRL, FTDI_DTR_ON);
    await vendor(SIO_SET_MODEM_CTRL, FTDI_RTS_ON);
    log('FTDI configured (D2XX sequence)');

    const alt = device.configuration.interfaces[0].alternates[0];
    const epIn = alt.endpoints.find(e => e.direction === 'in');
    const epOut = alt.endpoints.find(e => e.direction === 'out');
    const epOutNum = epOut ? epOut.endpointNumber : null;
    log(`Endpoints: IN=${epIn?.endpointNumber} OUT=${epOutNum}`);
    return { device, epIn, epOutNum };
}

export async function setFtdiBaud(device, baudRate) {
    const { wValue, wIndex } = ftdiBaudDivisor(baudRate);
    await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_SET_BAUD_RATE, value: wValue, index: wIndex });
}

export function ftdiSerial({ device, epIn, epOutNum }) {
    const pktSz = epIn.packetSize || FTDI_DEFAULT_PACKET_SIZE;
    let buffered = new Uint8Array(0);

    async function pull() {
        const result = await device.transferIn(epIn.endpointNumber, USB_TRANSFER_SIZE);
        if (result.status !== 'ok' || !result.data) return;
        const raw = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
        const chunks = [];
        for (let i = 0; i < raw.length; i += pktSz) {
            if (i + FTDI_HEADER_SIZE < Math.min(i + pktSz, raw.length)) chunks.push(raw.subarray(i + FTDI_HEADER_SIZE, i + pktSz));
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        if (!total) return;
        const next = new Uint8Array(buffered.length + total);
        next.set(buffered);
        let at = buffered.length;
        for (const c of chunks) { next.set(c, at); at += c.length; }
        buffered = next;
    }

    return {
        setBaud: baudRate => setFtdiBaud(device, baudRate),
        async write(bytes) { await device.transferOut(epOutNum, bytes); },
        async read(n, timeoutMs) {
            const deadline = performance.now() + timeoutMs;
            while (buffered.length < n && performance.now() < deadline) await pull();
            const out = buffered.slice(0, n);
            buffered = buffered.slice(out.length);
            return out;
        },
        async purge() {
            await pull();
            const stale = buffered;
            buffered = new Uint8Array(0);
            await device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: SIO_RESET, value: FTDI_PURGE_RX, index: 0 });
            return stale;
        },
    };
}

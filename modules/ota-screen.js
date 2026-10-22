import { log } from './ui.js';
import { openFtdi, ftdiSerial } from './ftdi.js';
import { parseLayout, upgradeAllParts, upgradeAll, OtaError } from './himax-ota.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb = n => `${(n / 1024).toFixed(1)} KB`;
const addr = v => '0x' + v.toString(16).toUpperCase().padStart(8, '0');

const files = { layout: null, image: null };
let parts = null;
let busy = false;

function show(on) {
    $('connect-chooser').style.display = on ? 'none' : 'flex';
    $('ota-panel').style.display = on ? 'flex' : 'none';
}

function setStatus(text, kind = '') {
    const el = $('ota-status');
    el.textContent = text;
    el.className = `ota-status${kind ? ` ota-status--${kind}` : ''}`;
}

const setBar = fraction => { $('ota-bar').style.width = `${Math.round(fraction * 100)}%`; };

function setBusy(on) {
    busy = on;
    for (const id of ['ota-layout', 'ota-image', 'ota-back']) $(id).disabled = on;
    $('ota-start').disabled = on || !parts;
}

function renderParts(entries) {
    const list = $('ota-parts');
    list.textContent = '';
    for (const e of entries) {
        const sent = parts ? parts.includes(e) : e.index >= 2;
        const row = document.createElement('div');
        row.className = `ota-part${sent ? '' : ' ota-part--skipped'}`;
        row.textContent = sent
            ? `${e.typeName} · ${e.security} · ${addr(e.addr)} · ${kb(e.size)}`
            : `${e.typeName} · not sent`;
        list.appendChild(row);
    }
}

function review() {
    parts = null;
    setBar(0);
    $('ota-parts').textContent = '';
    try {
        if (files.layout) {
            const { entries } = parseLayout(files.layout);
            if (files.image) parts = upgradeAllParts(entries, files.image.length);
            renderParts(entries);
        }
        setStatus(parts ? 'Ready. Connect the converter and tap Update.' : 'Pick layout.bin and output.img from the same build.');
    } catch (err) {
        setStatus(err.message, 'error');
    }
    $('ota-start').disabled = busy || !parts;
}

async function pick(which, input) {
    const file = input.files[0];
    files[which] = file ? new Uint8Array(await file.arrayBuffer()) : null;
    $(`ota-${which}-name`).textContent = file ? `${file.name} · ${kb(file.size)}` : 'Choose file';
    review();
}

function onProgress({ phase, part, position, count, sent, total }) {
    if (phase === 'connecting') setStatus('Looking for the camera…');
    if (phase === 'sending') setStatus(`Sending ${part.typeName} (${position} of ${count})… ${Math.floor(sent / total * 100)}%`);
    if (phase === 'burning') setStatus(`Writing ${part.typeName} to flash (${position} of ${count})…`);
    setBar(total ? sent / total : 1);
}

const guard = e => { e.preventDefault(); e.returnValue = ''; };

async function start() {
    if (!navigator.usb) {
        setStatus('This browser cannot reach USB devices. Use Chrome on Android or on a computer.', 'error');
        return;
    }
    setBusy(true);
    window.addEventListener('beforeunload', guard);
    let device = null;
    let wakeLock = null;
    try {
        wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
        setStatus('Choose the USB converter…');
        const port = await openFtdi();
        device = port.device;
        if (!port.epIn || !port.epOutNum) throw new OtaError('The USB converter has no serial endpoints.');
        const result = await upgradeAll({ link: ftdiSerial(port), layout: files.layout, image: files.image, log, sleep, onProgress });
        setBar(1);
        setStatus(`Done: ${result.parts} parts, ${kb(result.bytes)} at ${result.baud} baud. The camera is restarting.`, 'ok');
        log(`OTA: done at ${result.baud} baud`);
    } catch (err) {
        const message = err.name === 'NotFoundError' ? 'No USB converter selected.'
            : err instanceof OtaError ? err.message
            : `USB error: ${err.message}`;
        log(`OTA: ${message}`);
        setStatus(`${message} Raw replies are in the Device Log.`, 'error');
    } finally {
        try { await device?.close(); } catch (e) {}
        try { await wakeLock?.release(); } catch (e) {}
        window.removeEventListener('beforeunload', guard);
        setBusy(false);
    }
}

export function initOtaScreen() {
    if (!$('ota-btn') || !$('ota-panel')) return;
    $('ota-btn').onclick = () => { show(true); review(); };
    $('ota-back').onclick = () => show(false);
    $('ota-layout').onchange = e => pick('layout', e.target);
    $('ota-image').onchange = e => pick('image', e.target);
    $('ota-start').onclick = start;
}

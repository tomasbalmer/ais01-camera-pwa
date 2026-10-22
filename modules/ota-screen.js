import { log } from './ui.js';
import { openFtdi, ftdiSerial } from './ftdi.js';
import { parseLayout, upgradeAllParts, upgradeAll, OtaError } from './himax-ota.js';
import { CATALOG_PATH, parseCatalog, verifyFile } from './firmware-catalog.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kb = n => `${(n / 1024).toFixed(1)} KB`;
const addr = v => '0x' + v.toString(16).toUpperCase().padStart(8, '0');

const files = { layout: null, image: null };
let catalog = [];
let preset = null;
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
    for (const b of $('ota-presets').querySelectorAll('button')) b.disabled = on;
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
        const ready = 'Ready. Connect the converter and tap Update.'
            + (parts?.some(p => p.typeName === 'WATERMETER_CONF') ? ' This also replaces the camera calibration; calibrate it again afterwards.' : '');
        setStatus(parts ? ready : 'Choose a firmware, or pick layout.bin and output.img from the same build.');
    } catch (err) {
        setStatus(err.message, 'error');
    }
    $('ota-start').disabled = busy || !parts;
}

async function pick(which, input) {
    const file = input.files[0];
    if (preset) { preset = null; files.layout = files.image = null; renderPresets(); }
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
        const recalibrate = parts?.some(p => p.typeName === 'WATERMETER_CONF') ? ' Calibrate the camera again.' : '';
        setStatus(`Done: ${result.parts} parts, ${kb(result.bytes)} at ${result.baud} baud. The camera is restarting.${recalibrate}`, 'ok');
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

function renderPresets() {
    const box = $('ota-presets');
    box.textContent = '';
    for (const f of catalog) {
        const btn = document.createElement('button');
        btn.className = `ota-preset${preset === f ? ' ota-preset--active' : ''}`;
        btn.textContent = f.label;
        btn.disabled = busy;
        btn.onclick = () => choosePreset(f);
        box.appendChild(btn);
    }
}

async function fetchBytes(path) {
    const res = await fetch(path);
    if (!res.ok) throw new OtaError(`Could not download ${path.split('/').pop()} (HTTP ${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
}

async function choosePreset(f) {
    preset = f;
    files.layout = files.image = null;
    for (const which of ['layout', 'image']) { $(`ota-${which}`).value = ''; $(`ota-${which}-name`).textContent = 'Choose file'; }
    renderPresets();
    review();
    setStatus(`Loading ${f.label}…`);
    try {
        const [layout, image] = await Promise.all([fetchBytes(f.layout.path), fetchBytes(f.image.path)]);
        if (preset !== f) return;
        files.layout = await verifyFile(f, 'layout', layout);
        files.image = await verifyFile(f, 'image', image);
        log(`OTA: ${f.label} loaded, checksums match`);
        review();
    } catch (err) {
        if (preset !== f) return;
        preset = null;
        renderPresets();
        setStatus(err instanceof OtaError ? err.message : `Could not load ${f.label}: ${err.message}`, 'error');
    }
}

async function loadCatalog() {
    try {
        const res = await fetch(CATALOG_PATH);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        catalog = parseCatalog(await res.json());
    } catch (err) {
        catalog = [];
        log(`OTA: firmware list unavailable (${err.message})`);
    }
    renderPresets();
}

export function initOtaScreen() {
    if (!$('ota-btn') || !$('ota-panel')) return;
    $('ota-btn').onclick = () => { show(true); review(); loadCatalog(); };
    $('ota-back').onclick = () => show(false);
    $('ota-layout').onchange = e => pick('layout', e.target);
    $('ota-image').onchange = e => pick('image', e.target);
    $('ota-start').onclick = start;
}

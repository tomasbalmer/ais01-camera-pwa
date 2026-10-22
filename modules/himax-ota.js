import { HIMAX_OTA as OTA } from './constants.js';

export const PART_TYPES = [
    '1st_LOADER', '2nd_LOADER', '3rd_LOADER', 'MEMDSP', 'APPLICATION', 'APPLICATION_CONFIG',
    'CUST_ALGO_CONFIG', 'EMZA_CONFIG', 'CNN_LUT', 'LOGER', 'AUDIO_DATA', 'FR_DATA', 'STANDALONE',
    'STANDALONE_RAW', 'FLASHASSRAM', 'ALANGO', 'WATERMETER_CONF', 'ALGORITHM_MODEL', 'LOADER_CONFIG',
];
export const SECURITY_FORMATS = ['RAW', 'BLp', 'BLw', 'Hmac'];
export const STATUS_NAMES = [
    'APPLICATION_IDLE', 'OTA_LOADER_IDLE', 'OTA_EIP130_INIT', 'OTA_DATA_VERIFY', 'OTA_FLASH_CHECK', 'OTA_DONE',
    'OTA_LOADER_INIT', 'OTA_LOADER_RECEIVE', 'OTA_LOADER_BURN_FLASH',
];
export const ERROR_NAMES = ['NO_ERROR', 'SEC_INIT', 'SEC_TRNG', 'CHECKSUM', 'I2C_DRV / SEC_VERIFY', 'FLASH_CRC_CHECK_FAIL', 'UNKNOWN'];

export class OtaError extends Error {}

export function crc16(bytes) {
    let crc = 0xFFFF;
    for (let b of bytes) {
        for (let i = 0; i < 8; i++) {
            crc = ((crc ^ b) & 1) ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
            b >>>= 1;
        }
    }
    return crc;
}

export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
const hex32 = v => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
const u16le = v => [v & 0xFF, (v >>> 8) & 0xFF];
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function commandFrame(cmd, sub, length = 0) {
    const body = [cmd, sub, ...u16le(length)];
    return Uint8Array.from([OTA.SYNC, ...body, ...u16le(crc16(body))]);
}

export function dataFrame(payload) {
    const frame = new Uint8Array(payload.length + 2);
    frame.set(payload);
    frame.set(u16le(crc16(payload)), payload.length);
    return frame;
}

export function parseLayout(bytes) {
    const { LAYOUT_HEADER_SIZE: head, LAYOUT_ENTRY_SIZE: size, LAYOUT_MAX_ENTRIES: max } = OTA;
    if (bytes.length < head + size) {
        throw new OtaError(`layout.bin is ${bytes.length} bytes, too short to describe even one part.`);
    }
    const count = bytes[OTA.LAYOUT_COUNT_OFFSET];
    if (count === 0 || count > max) {
        throw new OtaError(`layout.bin says it holds ${count} parts; a valid file holds 1 to ${max}.`);
    }
    if (bytes.length < head + count * size) {
        throw new OtaError(`layout.bin says it holds ${count} parts but its ${bytes.length} bytes fit only `
            + `${Math.floor((bytes.length - head) / size)}.`);
    }
    const entries = [];
    for (let index = 0; index < count; index++) {
        const raw = bytes.slice(head + index * size, head + (index + 1) * size);
        const type = u32le(raw, 0);
        const att = u32le(raw, 4);
        entries.push({
            index, type, att, raw,
            addr: u32le(raw, 8),
            size: u32le(raw, 12),
            typeName: PART_TYPES[type] ?? `type ${type}`,
            security: SECURITY_FORMATS[att & 0x0F] ?? `format ${att & 0x0F}`,
        });
    }
    return { count, entries };
}

export function upgradeAllParts(entries, imageLength) {
    const skip = OTA.SKIPPED_LOADER_ENTRIES;
    const isLoader = e => OTA.LOADER_TYPES.includes(e.type);
    const skipped = entries.slice(0, skip);
    const odd = skipped.find(e => !isLoader(e));
    if (odd) {
        throw new OtaError(`Part ${odd.index + 1} of layout.bin is ${odd.typeName}, not a loader. Upgrade all skips the first `
            + `${skip} parts as loaders, so this file would leave ${odd.typeName} out.`);
    }
    const parts = entries.slice(skip);
    if (!parts.length) throw new OtaError('layout.bin lists only the loaders; there is nothing to update.');
    const loader = parts.find(isLoader);
    if (loader) {
        throw new OtaError(`layout.bin lists ${loader.typeName} as part ${loader.index + 1}; this screen never writes a loader.`);
    }
    for (const p of parts) {
        if (p.addr + p.size > imageLength) {
            throw new OtaError(`output.img is ${imageLength} bytes but ${p.typeName} needs bytes up to `
                + `${hex32(p.addr + p.size)}. Are layout.bin and output.img from the same build?`);
        }
    }
    return parts;
}

export function decodeStatus(value) {
    return { value, status: (value >>> 16) & 0xFF, error: value & 0xFF };
}

export function describeStatus({ status, error, value }) {
    const s = STATUS_NAMES[status] ?? 'unknown';
    const e = ERROR_NAMES[error] ?? 'unknown';
    return `status ${status} ${s}, error ${error} ${e} (${hex32(value)})`;
}

export function parseReply(header, payload) {
    const n = payload.length;
    if (n < OTA.REPLY_MIN_LENGTH) return { problem: `reply payload of ${n} bytes is too short` };
    const rx = payload[n - 2] | (payload[n - 1] << 8);
    if (rx === 0xFFFF) return { problem: 'reply checksum is FFFF (device still updating or short read)' };
    const crc = crc16(payload.subarray(0, n - 2));
    if (crc !== rx) {
        return { problem: `reply checksum error (got ${rx.toString(16).padStart(4, '0')}, expected ${crc.toString(16).padStart(4, '0')})` };
    }
    return { header: Array.from(header), ...decodeStatus(u32le(payload, n - 6)) };
}

export const isLoaderIdle = r => !r.problem && r.status === OTA.STATUS_LOADER_IDLE && r.error === 0;

export function burnWaitMs(size) {
    const blocks = size <= OTA.BURN_BLOCK_SIZE ? 1 : Math.ceil(size / OTA.BURN_BLOCK_SIZE);
    return blocks * OTA.DELAY_MS.BURN_PER_BLOCK;
}

const D = OTA.DELAY_MS;

async function send(ctx, cmd, sub, data = null, { quiet = false } = {}) {
    const header = commandFrame(cmd, sub, data ? data.length : 0);
    if (!quiet) ctx.log(`TX → ${hex(header)}`);
    await ctx.link.write(header);
    if (data && data.length) {
        await ctx.sleep(D.COMMAND_TO_DATA);
        const frame = dataFrame(data);
        if (!quiet) ctx.log(`TX → ${frame.length <= 32 ? hex(frame) : `${frame.length} bytes`}`);
        await ctx.link.write(frame);
    }
}

async function readReply(ctx) {
    await ctx.sleep(D.BEFORE_READ);
    const header = await ctx.link.read(OTA.REPLY_HEADER_SIZE, OTA.REPLY_TIMEOUT_MS);
    if (!header.length) return { problem: 'no answer' };
    if (header.length < OTA.REPLY_HEADER_SIZE) {
        ctx.log(`RX ← ${hex(header)}`);
        return { problem: `only ${header.length} of ${OTA.REPLY_HEADER_SIZE} header bytes` };
    }
    const length = u32le(header, OTA.REPLY_LENGTH_OFFSET);
    if (length < OTA.REPLY_MIN_LENGTH || length > OTA.REPLY_MAX_LENGTH) {
        ctx.log(`RX ← ${hex(header)}`);
        return { problem: `header says ${length} payload bytes, outside ${OTA.REPLY_MIN_LENGTH}..${OTA.REPLY_MAX_LENGTH}` };
    }
    const payload = await ctx.link.read(length, OTA.REPLY_TIMEOUT_MS);
    ctx.log(`RX ← ${hex(header)} | ${hex(payload)}`);
    if (payload.length < length) return { problem: `only ${payload.length} of ${length} payload bytes` };
    return parseReply(header, payload);
}

async function getStatus(ctx) {
    const stale = await ctx.link.purge();
    if (stale && stale.length) ctx.log(`RX (unsolicited, discarded) ← ${hex(stale)}`);
    await send(ctx, OTA.CMD_SYSTEM, OTA.SUB_GET_STATUS);
    await ctx.sleep(D.AFTER_STATUS_COMMAND);
    const reply = await readReply(ctx);
    ctx.log(`Getstatus: ${reply.problem ?? describeStatus(reply)}`);
    return reply;
}

async function findLoader(ctx) {
    for (const baud of ctx.bauds) {
        ctx.log(`OTA: trying ${baud} baud`);
        await ctx.link.setBaud(baud);
        let reply = await getStatus(ctx);
        if (isLoaderIdle(reply)) return baud;
        if (reply.problem || reply.status === OTA.STATUS_APPLICATION_IDLE) {
            ctx.log('OTA: Intoupg (application → 2nd loader)');
            await send(ctx, OTA.CMD_SYSTEM, OTA.SUB_INTO_UPGRADE);
            await ctx.sleep(D.AFTER_INTO_UPGRADE);
            reply = await getStatus(ctx);
            if (isLoaderIdle(reply)) return baud;
        }
        if (!reply.problem) {
            throw new OtaError(`The camera answers at ${baud} baud but is not ready to update: ${describeStatus(reply)}.`);
        }
    }
    throw new OtaError(`The camera did not answer at ${ctx.bauds.join(', ')} baud. Check the cable, that the camera `
        + 'is powered and that the converter is in UART mode.');
}

async function waitForBurn(ctx, part) {
    const attempts = Math.ceil(OTA.BURN_POLL_CAP_MS / OTA.BURN_POLL_MS);
    let reply = null;
    for (let i = 0; i < attempts; i++) {
        if (i) await ctx.sleep(OTA.BURN_POLL_MS);
        reply = await getStatus(ctx);
        if (reply.problem) continue;
        if (reply.error !== 0) throw new OtaError(`Writing ${part.typeName} failed: ${describeStatus(reply)}.`);
        if (OTA.READY_AFTER_BURN.includes(reply.status)) return;
    }
    throw new OtaError(`The camera did not report ${part.typeName} as written within ${OTA.BURN_POLL_CAP_MS / 1000} s`
        + ` (last: ${reply.problem ?? describeStatus(reply)}).`);
}

export async function upgradeAll({ link, layout, image, log = () => {}, onProgress = () => {}, sleep, bauds = OTA.BAUDS }) {
    const ctx = { link, log, sleep, bauds };
    const { entries } = parseLayout(layout);
    const parts = upgradeAllParts(entries, image.length);
    const total = parts.reduce((sum, p) => sum + p.size, 0);
    let sent = 0;
    const progress = (phase, part = null) => onProgress({ phase, part, position: parts.indexOf(part) + 1, count: parts.length, sent, total });

    progress('connecting');
    const baud = await findLoader(ctx);
    log(`OTA: 2nd loader ready at ${baud} baud; ${parts.length} parts, ${total} bytes`);

    for (const part of parts) {
        log(`OTA: ${part.typeName} (${part.security}) at ${hex32(part.addr)}, ${part.size} bytes`);
        progress('sending', part);
        await send(ctx, OTA.CMD_UPGRADE, OTA.SUB_START, part.raw);
        await ctx.sleep(D.AFTER_START);
        for (let off = 0; off < part.size; off += OTA.CHUNK_SIZE) {
            const n = Math.min(OTA.CHUNK_SIZE, part.size - off);
            await send(ctx, OTA.CMD_UPGRADE, OTA.SUB_DATA, image.subarray(part.addr + off, part.addr + off + n), { quiet: true });
            await ctx.sleep(D.AFTER_CHUNK);
            sent += n;
            progress('sending', part);
        }
        await ctx.sleep(D.AFTER_LAST_CHUNK);
        await send(ctx, OTA.CMD_UPGRADE, OTA.SUB_END);
        progress('burning', part);
        await ctx.sleep(burnWaitMs(part.size));
        await waitForBurn(ctx, part);
    }

    await ctx.sleep(D.BEFORE_FINAL_STATUS);
    const final = await getStatus(ctx);
    if (!isLoaderIdle(final)) {
        throw new OtaError(`Every part was sent but the camera reports ${final.problem ?? describeStatus(final)}; it was not rebooted.`);
    }
    log('OTA: ReBoot WEI');
    await send(ctx, OTA.CMD_SYSTEM, OTA.SUB_REBOOT);
    progress('done');
    return { baud, parts: parts.length, bytes: total };
}

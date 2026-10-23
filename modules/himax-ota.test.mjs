/*
 * himax-ota.js.  Run:  node modules/himax-ota.test.mjs
 */

import {
    crc16, commandFrame, dataFrame, parseLayout, upgradeAllParts, parseReply, burnWaitMs, upgradeAll, hex, OtaError,
} from './himax-ota.js';
import { makeFakeLoader } from './fake-himax-loader.js';
import { HIMAX_OTA } from './constants.js';

let failed = 0;
const check = (name, actual, expected) => {
    const okay = JSON.stringify(actual) === JSON.stringify(expected);
    if (!okay) failed++;
    console.log(`${okay ? 'ok  ' : 'FAIL'} ${name}` +
        (okay ? '' : `\n       expected ${JSON.stringify(expected)}` +
                     `\n       got      ${JSON.stringify(actual)}`));
};
const rejects = async (name, fn, fragment) => {
    let message = null;
    try { await fn(); } catch (err) { message = err instanceof OtaError ? err.message : `not an OtaError: ${err.message}`; }
    check(name, message !== null && message.includes(fragment), true);
    if (message === null || !message.includes(fragment)) console.log(`       message: ${message}`);
};
const bytes = s => Uint8Array.from(s.split(' ').map(h => parseInt(h, 16)));

const u32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, v >>> 24];
const entry = (type, att, addr, size) => [...u32(type), ...u32(att), ...u32(addr), ...u32(size)];
const layoutOf = (...entries) => {
    const header = new Array(16).fill(0);
    header[5] = entries.length;
    return Uint8Array.from([...header, ...entries.flat()]);
};
const imageOf = n => Uint8Array.from({ length: n }, (_, i) => (i ^ (i >>> 8)) & 0xFF);

const LAYOUT = layoutOf(
    entry(0, 1, 0x00000000, 0x4000),
    entry(1, 1, 0x00010000, 0x8000),
    entry(3, 1, 0x00020000, 0x5C4),
    entry(4, 1, 0x00021000, 12000),
);
const IMAGE = imageOf(0x21000 + 12000);

check('crc of "123456789" is the MCRF4XX check value', crc16(new TextEncoder().encode('123456789')), 0x6F91);
check('crc of nothing is the init value', crc16([]), 0xFFFF);
check('crc of the Getstatus body', crc16([0x50, 0x05, 0x00, 0x00]), 0xEF8A);

check('Intoupg', hex(commandFrame(0x50, 0x07)), 'c0 50 07 00 00 32 5a');
check('Getstatus', hex(commandFrame(0x50, 0x05)), 'c0 50 05 00 00 8a ef');
check('ReBoot', hex(commandFrame(0x50, 0x06)), 'c0 50 06 00 00 ee 00');
check('OTA_START header', hex(commandFrame(0x51, 0x02, 16)), 'c0 51 02 10 00 a5 ea');
check('OTA_DATA header, full chunk', hex(commandFrame(0x51, 0x03, 5120)), 'c0 51 03 00 14 4d 73');
check('OTA_DATA header, short chunk', hex(commandFrame(0x51, 0x03, 0x5C4)), 'c0 51 03 c4 05 8f df');
check('OTA_END', hex(commandFrame(0x51, 0x04)), 'c0 51 04 00 00 ed a9');
check('OTA_START data frame carries the entry and its crc',
      hex(dataFrame(Uint8Array.from(entry(3, 1, 0x20000, 0x5C4)))),
      '03 00 00 00 01 00 00 00 00 00 02 00 c4 05 00 00 fc 37');
check('OTA_DATA data frame', hex(dataFrame(bytes('00 01 02 03'))), '00 01 02 03 d6 58');

const parsed = parseLayout(LAYOUT);
check('the count comes from header byte 5', parsed.count, 4);
check('an entry is type, att, address and size',
      (({ type, att, addr, size, typeName, security }) => ({ type, att, addr, size, typeName, security }))(parsed.entries[2]),
      { type: 3, att: 1, addr: 0x20000, size: 0x5C4, typeName: 'MEMDSP', security: 'BLp' });
check('the raw 16 bytes are kept for OTA_START', Array.from(parsed.entries[3].raw), entry(4, 1, 0x21000, 12000));
await rejects('a file shorter than one entry is refused', () => parseLayout(new Uint8Array(20)), 'too short');
await rejects('a count of zero is refused', () => parseLayout(new Uint8Array(32)), 'holds 0 parts');
await rejects('a count the file cannot hold is refused', () => parseLayout(LAYOUT.slice(0, 16 + 3 * 16)), 'fit only 3');

check('upgrade all skips the two loaders',
      upgradeAllParts(parsed.entries, IMAGE.length).map(p => p.typeName), ['MEMDSP', 'APPLICATION']);
await rejects('a layout whose first entries are not loaders is refused',
      () => upgradeAllParts(parseLayout(layoutOf(entry(3, 1, 0, 4), entry(1, 1, 4, 4), entry(4, 1, 8, 4))).entries, 64),
      'not a loader');
await rejects('a loader after the skipped two is never written',
      () => upgradeAllParts(parseLayout(layoutOf(entry(0, 1, 0, 4), entry(1, 1, 4, 4), entry(2, 1, 8, 4))).entries, 64),
      'never writes a loader');
await rejects('a layout with only loaders has nothing to send',
      () => upgradeAllParts(parseLayout(layoutOf(entry(0, 1, 0, 4), entry(1, 1, 4, 4))).entries, 64),
      'nothing to update');
await rejects('an image shorter than the layout is refused',
      () => upgradeAllParts(parsed.entries, IMAGE.length - 1), 'same build');

const header = bytes('c0 5a 01 0b 00 00 00');
const body = [0xC0, 0x50, 0x05, 0x00, 0x04, 0x00, 0x00, 0x01, 0x00];
const c = crc16(body);
check('a Getstatus reply decodes status and error',
      (({ status, error, value }) => ({ status, error, value }))(parseReply(header, Uint8Array.from([...body, c & 0xFF, c >>> 8]))),
      { status: 1, error: 0, value: 0x00010000 });
check('the reply an AIS01 loader sent decodes as loader idle',
      (({ status, error }) => ({ status, error }))(parseReply(header, bytes('c0 50 05 00 04 00 00 01 00 4e 96'))),
      { status: 1, error: 0 });
check('a reply with a wrong crc is a problem',
      'problem' in parseReply(header, Uint8Array.from([...body, c & 0xFF, (c >>> 8) ^ 1])), true);
check('a reply still holding the FF fill is a problem',
      'problem' in parseReply(header, Uint8Array.from([...body, 0xFF, 0xFF])), true);

check('a part up to 64 KiB waits one second', [burnWaitMs(0x5C4), burnWaitMs(0x10000)], [1000, 1000]);
check('a larger part waits a second per started 64 KiB', [burnWaitMs(0x10001), burnWaitMs(0xBE6F0)], [2000, 12000]);

const run = async (options = {}, extra = {}) => {
    const fake = makeFakeLoader(options);
    const sleeps = [];
    const lines = [];
    const result = await upgradeAll({
        link: fake.link, layout: LAYOUT, image: IMAGE,
        sleep: async ms => { sleeps.push(ms); }, log: l => lines.push(l), ...extra,
    });
    return { fake, sleeps, lines, result };
};

{
    const { fake, result, sleeps, lines } = await run();
    check('the update runs at 921600', result.baud, 921600);
    check('every frame the loader received was well formed', fake.events.filter(e => e.bad), []);
    check('each part opens with its own layout entry',
          fake.parts.map(p => p.entry), [entry(3, 1, 0x20000, 0x5C4), entry(4, 1, 0x21000, 12000)]);
    check('each part carries exactly its slice of output.img',
          fake.parts.map(p => {
              const addr = p.entry[8] | (p.entry[9] << 8) | (p.entry[10] << 16);
              const size = p.entry[12] | (p.entry[13] << 8) | (p.entry[14] << 16);
              return hex(p.bytes) === hex(IMAGE.subarray(addr, addr + size));
          }), [true, true]);
    check('a part is closed with OTA_END', fake.parts.map(p => p.ended), [true, true]);
    check('the application goes in 5120-byte chunks',
          fake.events.filter(e => e.sub === 0x03 && e.cmd === 0x51).map(e => e.length), [0x5C4, 5120, 5120, 1760]);
    check('the camera is rebooted at the end', fake.rebooted, true);
    check('8 ms separate every command frame from its data frame',
          sleeps.filter(ms => ms === HIMAX_OTA.DELAY_MS.COMMAND_TO_DATA).length, 2 + 4);
    check('each part waits its burn time', sleeps.filter(ms => ms === 1000).length, 2);
    check('raw replies are logged in hex', lines.some(l => l.startsWith('RX ← c0 5a 01 0b 00 00 00 | c0 50 05 00 04')), true);
}

{
    const progress = [];
    await run({}, { onProgress: p => progress.push(`${p.phase}:${p.sent}`) });
    check('progress runs from connecting to done',
          [progress[0], progress.at(-1)], ['connecting:0', `done:${0x5C4 + 12000}`]);
}

{
    const { fake, result, sleeps } = await run({ startInApp: true });
    check('a camera in its application is sent into the loader', fake.inLoader, true);
    check('the 2 s after Intoupg is waited', sleeps.includes(HIMAX_OTA.DELAY_MS.AFTER_INTO_UPGRADE), true);
    check('and the update completes', result.parts, 2);
}

{
    const { fake, lines } = await run({ startInApp: true, ignoredIntoupg: 3 });
    check('Intoupg is sent again until the camera enters the loader',
          [lines.filter(l => l.startsWith('OTA: Intoupg')).length, fake.rebooted], [4, true]);
}

check('Intoupg goes first, before any Getstatus',
      (await run({ startInApp: true })).fake.events.slice(0, 2).map(e => e.sub), [0x07, 0x05]);

check('a loader that is busy for a few polls after a burn is waited for',
      (await run({ busyPolls: 3 })).fake.rebooted, true);

await rejects('a camera that never answers fails with a clear message', () => run({ silent: true }), 'did not enter its update mode after 10 tries');
await rejects('a burn error stops the update', () => run({ burnError: 5 }), 'Writing MEMDSP failed');

{
    const fake = makeFakeLoader({ burnError: 5 });
    try {
        await upgradeAll({ link: fake.link, layout: LAYOUT, image: IMAGE, sleep: async () => {} });
    } catch (err) {}
    check('nothing after a failed part is sent, and the camera is not rebooted', [fake.parts.length, fake.rebooted], [1, false]);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

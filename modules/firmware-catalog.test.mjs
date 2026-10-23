/*
 * firmware-catalog.js and the firmware shipped in firmware/.  Run:  node modules/firmware-catalog.test.mjs
 */

import { readFileSync } from 'node:fs';
import { parseCatalog, sha256Hex, verifyFile, CATALOG_PATH } from './firmware-catalog.js';
import { parseLayout, upgradeAllParts, OtaError } from './himax-ota.js';

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
const root = new URL('../', import.meta.url);
const read = path => new Uint8Array(readFileSync(new URL(path, root)));

check('sha256 of "abc"', await sha256Hex(new TextEncoder().encode('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

const fw = { id: 'x', label: 'X', layout: { path: 'a/layout.bin', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
             image: { path: 'a/output.img', sha256: '0'.repeat(64) } };
check('a file that matches its checksum passes', (await verifyFile(fw, 'layout', new TextEncoder().encode('abc'))).length, 3);
await rejects('a file that does not match is refused', () => verifyFile(fw, 'image', new Uint8Array(4)), 'output.img does not match');
await rejects('an entry without checksums is refused', () => parseCatalog([{ id: 'x', label: 'X', layout: { path: 'p' } }]), 'missing');
await rejects('a catalog that is not a list is refused', () => parseCatalog({}), 'not a list');

const catalog = parseCatalog(JSON.parse(new TextDecoder().decode(read(CATALOG_PATH))));
check('the shipped catalog lists Camera firmware 2023-05', catalog.map(f => f.label), ['Camera firmware 2023-05']);
for (const f of catalog) {
    const layout = await verifyFile(f, 'layout', read(f.layout.path));
    const image = await verifyFile(f, 'image', read(f.image.path));
    const parts = upgradeAllParts(parseLayout(layout).entries, image.length);
    check(`${f.label}: both files match their checksums and upgrade all accepts them`, parts.length > 0, true);
    check(`${f.label}: the parts sent`, parts.map(p => p.typeName),
          ['MEMDSP', 'LOADER_CONFIG', 'APPLICATION', 'APPLICATION', 'APPLICATION', 'APPLICATION', 'APPLICATION',
           'WATERMETER_CONF', 'ALGORITHM_MODEL']);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

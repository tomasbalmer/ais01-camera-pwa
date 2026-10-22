import { OtaError } from './himax-ota.js';

export const CATALOG_PATH = 'firmware/index.json';

const SHA256 = /^[0-9a-f]{64}$/;

export function parseCatalog(json) {
    if (!Array.isArray(json)) throw new OtaError('The firmware list is not a list.');
    return json.map((f, i) => {
        const ok = f && typeof f.id === 'string' && typeof f.label === 'string'
            && ['layout', 'image'].every(k => f[k] && typeof f[k].path === 'string' && SHA256.test(f[k].sha256));
        if (!ok) throw new OtaError(`Firmware ${i + 1} in the list is missing its name, files or checksums.`);
        return f;
    });
}

export async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyFile(firmware, which, bytes) {
    const name = firmware[which].path.split('/').pop();
    if (await sha256Hex(bytes) !== firmware[which].sha256) {
        throw new OtaError(`${firmware.label}: ${name} does not match its checksum; it was not sent. Reload the app and try again.`);
    }
    return bytes;
}

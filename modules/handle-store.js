/*
 * One directory handle, kept across reloads.
 *
 * A `FileSystemDirectoryHandle` is a reference to a folder on this machine, not
 * a copy of what is in it. It is structured-cloneable and therefore storable —
 * but only in IndexedDB, which is the whole reason this module exists:
 * `localStorage` holds strings, so remembering a folder through it means
 * remembering the BYTES of the folder, and for this app those bytes are a
 * device's private key and console password.
 *
 * The distinction is the point:
 *
 *     localStorage   the certificate, the key and the password, in plain text,
 *                    on a shared origin, outliving the session that read them
 *     this           "the folder was called X and you had permission to it",
 *                    with the material re-read from disk every time
 *
 * A stored handle is not stored access. The permission is a separate thing the
 * browser tracks, and after a reload it usually has to be re-granted by a
 * gesture — see `ensureAccess` in provision.js, which treats that as the normal
 * path rather than an error.
 */

const DB_NAME = 'ais01.provision';
const STORE = 'handles';
const KEY = 'device-folder';

function open() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/* One transaction, closed afterwards either way — a connection left open holds
 * a version change and this is the only writer. */
async function run(mode, fn) {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const req = fn(db.transaction(STORE, mode).objectStore(STORE));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

export const saveHandle = handle => run('readwrite', s => s.put(handle, KEY));
export const loadHandle = () => run('readonly', s => s.get(KEY));
export const clearHandle = () => run('readwrite', s => s.delete(KEY));

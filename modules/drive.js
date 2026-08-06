/*
 * Google Drive as the source of device folders.
 *
 * The technician has a phone, a unit, and no laptop. Until now the per-unit
 * material had to already be on the phone — downloaded ahead of time, one
 * folder per unit, and stale the moment ops rotated a certificate. This reads
 * the same folder straight from Drive.
 *
 * The design decision worth stating: **access control is Drive sharing, and
 * nothing here.** The app lists what the signed-in account can already see, so
 * a folder that is not shared does not exist as far as this module is
 * concerned, and unsharing removes it with no deploy. There is deliberately no
 * allow-list, no folder ID to paste, and no server in the middle to maintain.
 *
 * What this module does NOT do is equally deliberate:
 *
 *   - no token storage. The access token lives in a variable for the life of
 *     the page and is never written to localStorage. A phone at a meter is a
 *     phone that gets left on a table; an hour-long token in memory dies with
 *     the tab, a token in storage does not.
 *   - no writes. The scope is read-only, so a bug here cannot damage the
 *     folder that is the only copy of a unit's identity.
 *   - no parsing. It returns file text; `provision.js` builds the bundle, the
 *     same way it does for a locally picked folder. One path for what a bundle
 *     means, two paths for where the bytes came from.
 */

import { GOOGLE_CLIENT_ID, DEVICE_FOLDER_PREFIX } from './config.js';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

/*
 * Read-only over the account's Drive.
 *
 * Google has no "read only this folder" scope, so the narrow-scope
 * alternative is the Picker (`drive.file`, access to exactly what the user
 * taps) — which cannot look a folder up by IMEI, because the app never sees
 * anything it was not handed. Choosing this scope is choosing the automatic
 * lookup, and it is safe here for one reason: what the token can read is what
 * the signed-in account can read, and that is a sharing decision made outside
 * this app by the person who owns the folders.
 */
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

let accessToken = null;
let tokenClient = null;

export function isSignedIn() {
    return !!accessToken;
}

export function isConfigured() {
    return !!GOOGLE_CLIENT_ID;
}

/* Load Google Identity Services once, on first use rather than on page load —
 * a bench session that never touches Drive should not pay for it, and the app
 * has to keep working when the network does not. */
function loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
        if (existing) {
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error('could not load Google sign-in')));
            return;
        }
        const s = document.createElement('script');
        s.src = GIS_SRC;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('could not load Google sign-in — offline?'));
        document.head.appendChild(s);
    });
}

/*
 * Sign in and hold a token for this page.
 *
 * Resolves to the token, or null when the operator closes the Google window —
 * a choice, not an error, and not thrown. Same contract as `connect()` in
 * ble-transport.js, on purpose: the two "the user may walk away" moments in
 * this app should not need different handling.
 */
export async function signIn() {
    if (!GOOGLE_CLIENT_ID) {
        throw new Error('no Google client ID — see modules/config.js');
    }
    await loadGis();

    if (!tokenClient) {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: GOOGLE_CLIENT_ID,
            scope: SCOPE,
            callback: () => {},   /* replaced per request below */
        });
    }

    return new Promise((resolve, reject) => {
        tokenClient.callback = response => {
            if (response.error) {
                /* The operator closing the popup arrives here too. */
                if (/access_denied|popup_closed/i.test(response.error)) resolve(null);
                else reject(new Error(response.error));
                return;
            }
            accessToken = response.access_token;
            resolve(accessToken);
        };
        tokenClient.requestAccessToken();
    });
}

export function signOut() {
    accessToken = null;
}

async function api(url) {
    if (!accessToken) throw new Error('not signed in to Drive');
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401) {
        /* An expired token is the normal end of a long bench session, and it
         * should read as "sign in again", not as a Drive failure. */
        accessToken = null;
        throw new Error('Drive session expired — sign in again');
    }
    if (!res.ok) throw new Error(`Drive ${res.status}: ${await res.text()}`);
    return res;
}

/*
 * Every device folder this account can see.
 *
 * `includeItemsFromAllDrives` is what makes a Shared Drive work; without it
 * the query silently returns only "My Drive" and a folder that is plainly
 * there looks missing.
 */
export async function listDeviceFolders() {
    const q = [
        "mimeType='application/vnd.google-apps.folder'",
        `name contains '${DEVICE_FOLDER_PREFIX}'`,
        'trashed=false',
    ].join(' and ');
    const url = `${DRIVE_API}?q=${encodeURIComponent(q)}` +
        '&fields=files(id,name)&pageSize=200&orderBy=name' +
        '&supportsAllDrives=true&includeItemsFromAllDrives=true';
    const { files } = await (await api(url)).json();
    return files || [];
}

/* The files directly inside one folder. */
export async function listFolderFiles(folderId) {
    const q = `'${folderId}' in parents and trashed=false`;
    const url = `${DRIVE_API}?q=${encodeURIComponent(q)}` +
        '&fields=files(id,name)&pageSize=200' +
        '&supportsAllDrives=true&includeItemsFromAllDrives=true';
    const { files } = await (await api(url)).json();
    return files || [];
}

/* One file's contents as text. PEMs and password.txt are all this reads. */
export async function fileText(fileId) {
    const url = `${DRIVE_API}/${fileId}?alt=media&supportsAllDrives=true`;
    return (await api(url)).text();
}

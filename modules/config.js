/*
 * The values that change per deployment, in one place.
 *
 * Everything else in this app is either the same on every unit (the Amazon root
 * CA, the BT24 service UUID) or comes from the device folder. These two do not
 * belong in either category: they identify OUR Google project and nothing about
 * a device, and the alternative to naming them here is finding them inlined in
 * three modules a year from now.
 *
 * Neither is a secret. In a browser OAuth flow the client ID is public by
 * construction — it travels in the authorization URL, and Google's protection
 * is the authorized-origins list, not obscurity. Which is why this file is in
 * git while `password.txt` never is.
 */

/*
 * Google Cloud → APIs & Services → Credentials → Create credentials →
 * OAuth client ID → Web application.
 *
 * Add every origin the app is served from under "Authorized JavaScript
 * origins" — the deployed one and the bench one are different origins and both
 * have to be listed:
 *
 *     https://tomasbalmer.github.io
 *     http://localhost:8777
 *
 * The Google Drive API must be enabled on the same project.
 */
export const GOOGLE_CLIENT_ID = '';

/*
 * Which Drive folders are offered as device folders.
 *
 * The app lists folders the signed-in account can see whose name matches this,
 * so access is controlled entirely by Drive sharing: a folder that is not
 * shared with the technician does not appear, and unsharing it removes it. No
 * allow-list to maintain here, and no folder ID to paste.
 */
export const DEVICE_FOLDER_PREFIX = 'AIS01-CB-';

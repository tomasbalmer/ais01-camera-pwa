/*
 * The single place this app's version is written.
 *
 * It exists to answer one question from the device, in the field, with no
 * console: **is the code I am looking at the code I just deployed?** Modules
 * are fetched through the service worker with `cache: 'no-store'`, so they are
 * always fresh — but `index.html` itself can still come from cache, and a PWA
 * launched from the home screen does exactly that. When the shell is stale and
 * the modules are not, nothing on screen says so. This does.
 *
 * Bump it in the same commit as the change it describes:
 *   patch  a fix to something that already worked
 *   minor  a new capability
 *
 * If the number on screen is not the number in this file, you are looking at a
 * cached shell — pull to refresh, or reinstall the app from the home screen.
 */

export const VERSION = '0.36.0';

/* One line, for the places that want context rather than just a number. */
export const VERSION_NOTE = 'the radio sleeps during the write — it was ' +
    'resetting mid-upload, not losing bytes';

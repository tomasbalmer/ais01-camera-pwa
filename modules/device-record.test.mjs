/*
 * device-record.js.  Run:  node modules/device-record.test.mjs
 *
 * No framework, same as certmod.test.mjs — this repo has no build step and
 * should not grow one.
 *
 * These cover the failures that are silent. Writing a log line is not a thing
 * that throws when it goes wrong: it produces a file that parses as one line
 * fewer, or an `intended-config.json` missing every setting the CLI put there.
 * Both are discovered by somebody reading the record weeks later to find out
 * what happened to a unit, which is the one moment it has to be right.
 */

import {
    nowIso, logEntry, serialiseLog, mergeIntendedConfig,
    appendLog, saveIntendedConfig, LOG_FILE, CONFIG_FILE,
} from './device-record.js';

let failed = 0;
const check = (name, actual, expected) => {
    const okay = JSON.stringify(actual) === JSON.stringify(expected);
    if (!okay) failed++;
    console.log(`${okay ? 'ok  ' : 'FAIL'} ${name}` +
        (okay ? '' : `\n       expected ${JSON.stringify(expected)}` +
                     `\n       got      ${JSON.stringify(actual)}`));
};

/* ── A folder, in memory ─────────────────────────────────────────────────
 * Enough of FileSystemDirectoryHandle for these functions: they only ever
 * getFileHandle / getFile().text() / createWritable().write().close(). */
function fakeDir(files = {}) {
    return {
        files,
        async getFileHandle(name, options = {}) {
            if (!(name in files) && !options.create) {
                const err = new Error('NotFoundError');
                err.name = 'NotFoundError';
                throw err;
            }
            if (!(name in files)) files[name] = '';
            return {
                async getFile() { return { text: async () => files[name] }; },
                async createWritable() {
                    let buffer = '';
                    return {
                        async write(text) { buffer += text; },
                        async close() { files[name] = buffer; },
                    };
                },
            };
        },
    };
}

/* ── The clock ───────────────────────────────────────────────────────────
 * Local, not UTC. A log where half the lines are the bench's clock and half
 * are UTC cannot be put in order by eye, which is the only way it is read. */
const when = new Date(2026, 7, 9, 14, 32, 7);
const stamp = nowIso(when);
check('nowIso keeps the local wall clock',
      stamp.slice(0, 19), '2026-08-09T14:32:07');
check('nowIso carries an offset, not a Z', /[+-]\d{2}:\d{2}$/.test(stamp), true);

/* ── One line ────────────────────────────────────────────────────────── */
const entry = logEntry({
    imei: '869181072714122',
    stage: '1_write_certs_certmod',
    substep: 'certificates_written',
    summary: 'three files accepted',
    evidence: ['cacert.pem: +QFUPL: 1208,5769'],
    version: '0.58.0',
    at: stamp,
});
check('an entry with a substep is a substep_done', entry.event, 'substep_done');
check('the fields the CLI writes are all present',
      Object.keys(entry).sort(),
      ['actor', 'app_version', 'at', 'event', 'evidence_refs', 'imei',
       'process', 'source', 'stage', 'status', 'substep', 'summary']);
check('a line is one JSON object and one newline',
      serialiseLog(entry).endsWith('}\n'), true);
check('and it holds no embedded newline to split it',
      serialiseLog(entry).trimEnd().includes('\n'), false);

/* ── Merging, not replacing ──────────────────────────────────────────────
 * The CLI writes this file too, and it holds settings this app never sends —
 * APN, QCOPS, GDNS were set by hand. Overwriting with only what ③ sent would
 * silently delete the record of every one of them. */
const existing = {
    schema_version: 1,
    settings: {
        APN: { value: 'NULL', source: 'operator_chat', set_at: '2026-07-03T12:48:05-03:00' },
        SNI: { value: '1', source: 'stale', set_at: '2026-07-01T00:00:00-03:00' },
    },
};
const merged = mergeIntendedConfig(
    existing, [['AT+SNI', '0'], ['AT+SERVADDR', 'host,8883']],
    { at: stamp, source: 'ais01-pwa' });

check('settings this app never sends survive', merged.settings.APN.value, 'NULL');
check('and keep whoever set them', merged.settings.APN.source, 'operator_chat');
check('the AT+ prefix is stripped, as the CLI writes it',
      Object.keys(merged.settings).sort(), ['APN', 'SERVADDR', 'SNI']);
check('a setting we sent is updated, not duplicated', merged.settings.SNI.value, '0');
check('and re-attributed to this app', merged.settings.SNI.source, 'ais01-pwa');
check('schema_version is carried, never invented', merged.schema_version, 1);
check('the original object is not mutated', existing.settings.SNI.value, '1');

const fresh = mergeIntendedConfig(null, [['AT+TDC', '1200']], { at: stamp });
check('a unit with no file yet gets schema_version 1', fresh.schema_version, 1);

/* ── Appending ───────────────────────────────────────────────────────────
 * The separator is the whole test. A previous file that does not end in a
 * newline would otherwise get this entry glued onto its last line, and the
 * cost is not one bad line — it is both of them, and the file stops being
 * JSONL at the point somebody needs to parse it. */
const empty = fakeDir();
await appendLog(empty, logEntry({ imei: '1', stage: 's', summary: 'first', at: stamp }));
check('the first line ends the file with a newline',
      empty.files[LOG_FILE].split('\n').length, 2);

const truncated = fakeDir({ [LOG_FILE]: '{"at":"earlier","summary":"no newline"}' });
await appendLog(truncated, logEntry({ imei: '1', stage: 's', summary: 'second', at: stamp }));
const lines = truncated.files[LOG_FILE].trimEnd().split('\n');
check('a file with no trailing newline gets one before the append', lines.length, 2);
check('and every line still parses',
      lines.every(l => { try { JSON.parse(l); return true; } catch { return false; } }),
      true);

/* ── Refusing to clobber ─────────────────────────────────────────────────
 * A file we cannot parse is one somebody else is writing in a shape we do not
 * know. The settings in it are the only copy of decisions made elsewhere. */
const broken = fakeDir({ [CONFIG_FILE]: '{ this is not json' });
let refused = false;
try { await saveIntendedConfig(broken, [['AT+SNI', '0']]); }
catch { refused = true; }
check('unparseable intended-config.json is refused, not overwritten', refused, true);
check('and it is left exactly as it was',
      broken.files[CONFIG_FILE], '{ this is not json');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

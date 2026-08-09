/*
 * What this session did, written back into the unit's own folder.
 *
 * The folder is already where a unit's material lives, and since v0.56.0 the
 * app holds a writable handle to it rather than a copy of its contents. So the
 * record of what was done to the unit goes back beside the material it was done
 * with — the same place `firmware-factory/devices/<unit>/` keeps it in the CLI,
 * in the same two files, so a unit provisioned from the phone and a unit
 * provisioned from the laptop leave the same trail.
 *
 *     provisioning-log.jsonl   append-only, one line per thing that happened
 *     intended-config.json     the settings this unit is meant to have
 *
 * WHAT IS DELIBERATELY NOT WRITTEN
 *
 * `provisioning-state.json`. That file is a stage machine with per-substep
 * freshness, staleness policies and inference records, and it exists because
 * the CLI's decider is an LLM that is frozen between turns and has to
 * reconstruct device state every time it wakes. Spec 004 removes that decider
 * and the machinery with it; writing the file anyway would be this app
 * asserting a device state it explicitly refuses to infer. The log says what
 * happened. Nothing here says what the unit IS.
 *
 * WHAT GETS A LINE
 *
 * Only actions that changed the unit or proved something about it — ②, ③ and
 * ④. Opening a folder and logging into a console are session bookkeeping, and
 * a log that records every reload stops being readable at exactly the moment
 * somebody needs to read it.
 *
 * Every write is best-effort. A permission that lapsed, a folder that moved, a
 * disk that is full — none of them may take down a stage that is talking to a
 * device. The record is evidence about provisioning, never a step in it.
 */

export const LOG_FILE = 'provisioning-log.jsonl';
export const CONFIG_FILE = 'intended-config.json';

/* Stage keys from `firmware-factory/stages.json` → `routes.v1_3.order`. That
 * file is the authority; these are pointers to it, never a second opinion. */
export const STAGES = {
    identify: '0_identify',
    certs: '1_write_certs_certmod',
    config: '4_config_mqtt_network',
    verify: '5_verify_runtime',
};

/* ── Pure ────────────────────────────────────────────────────────────────
 *
 * Everything below this line is testable with no browser and no device, which
 * is the point: the parts that touch a FileSystemHandle can only be exercised
 * against a real folder a person picked, and the parts that decide what to
 * write should not have to wait for one.
 */

/*
 * ISO 8601 with the LOCAL offset — `2026-08-09T14:32:07-03:00`.
 *
 * Not `toISOString()`, which is UTC. The CLI's entries carry the bench's own
 * offset, and a log where half the lines are local and half are UTC is a log
 * nobody can put in order by eye. The bench is where the unit is; that is the
 * clock a technician reads.
 */
export function nowIso(date = new Date()) {
    const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
        `${sign}${pad(offset / 60 | 0)}:${pad(offset % 60)}`;
}

/*
 * One line of the log, in the field set the CLI already writes.
 *
 * `actor`/`process`/`source` say who did it, and they are honest about this
 * app: not a human typing, not an agent deciding — a tool a person drove.
 * `app_version` rides along because a log without one cannot be placed, which
 * is the same reason the terminal prints it as its first line.
 */
export function logEntry({
    imei, stage, substep, status = 'done', summary, evidence = [], version,
    at = nowIso(),
}) {
    const entry = {
        at,
        imei,
        event: substep ? 'substep_done' : 'stage_done',
        stage,
        actor: 'app',
        process: 'ais01-pwa',
        source: 'ble_bench',
        summary,
        evidence_refs: evidence,
    };
    if (substep) entry.substep = substep;
    entry.status = status;
    if (version) entry.app_version = version;
    return entry;
}

export function serialiseLog(entry) {
    return JSON.stringify(entry) + '\n';
}

/*
 * Merge, never replace.
 *
 * The CLI writes this file too, and it holds settings this app does not touch —
 * `APN`, `QCOPS`, `GDNS` were all set by hand or by a script and are not in
 * `desiredSettings`. Overwriting the file with only what ③ sent would silently
 * delete the record of every one of them, and this file's whole job is to be
 * the standing answer to "what is this unit meant to have".
 *
 * Keys are stored WITHOUT the `AT+` prefix, which is how the CLI writes them.
 */
export function mergeIntendedConfig(existing, applied, { at = nowIso(), source = 'ais01-pwa' } = {}) {
    const base = (existing && typeof existing === 'object') ? existing : {};
    const merged = {
        schema_version: base.schema_version || 1,
        ...base,
        settings: { ...(base.settings || {}) },
    };
    for (const [name, value] of applied) {
        merged.settings[name.replace(/^AT\+/i, '')] = {
            value: String(value),
            source,
            set_at: at,
        };
    }
    return merged;
}

/* ── The folder ──────────────────────────────────────────────────────────
 *
 * `createWritable()` truncates, so an append is read-then-write-whole. The log
 * is a few dozen lines of a few hundred bytes; the simplicity is worth more
 * here than the syscalls saved by seeking, and a partial seek-write on a file
 * somebody has open in an editor is a corrupted record rather than a slow one.
 */

async function readTextIfPresent(dir, name) {
    try {
        const handle = await dir.getFileHandle(name);
        return await (await handle.getFile()).text();
    } catch {
        return '';   /* absent is the normal case for a unit's first session */
    }
}

async function writeText(dir, name, text) {
    const handle = await dir.getFileHandle(name, { create: true });
    const stream = await handle.createWritable();
    try {
        await stream.write(text);
    } finally {
        await stream.close();
    }
}

/*
 * Append one entry. Returns the entry on success and null when the folder
 * would not take it — the caller says so in the terminal and carries on.
 */
export async function appendLog(dir, entry) {
    if (!dir) return null;
    const previous = await readTextIfPresent(dir, LOG_FILE);
    /* A file that does not end in a newline would otherwise get this entry
     * glued onto its last line, which costs the whole file its parseability. */
    const separator = previous && !previous.endsWith('\n') ? '\n' : '';
    await writeText(dir, LOG_FILE, previous + separator + serialiseLog(entry));
    return entry;
}

/* Merge the settings that were ACCEPTED — never the ones that were merely
 * sent. A setting the device answered `ERROR` to is not what the unit is meant
 * to have; it is what somebody tried. */
export async function saveIntendedConfig(dir, applied, options) {
    if (!dir || !applied.length) return null;
    const raw = await readTextIfPresent(dir, CONFIG_FILE);
    let existing = null;
    if (raw.trim()) {
        try { existing = JSON.parse(raw); } catch {
            /* Refuse rather than clobber. A file we cannot parse is a file
             * somebody else is writing in a shape we do not know, and the
             * settings in it are the only copy of decisions made elsewhere. */
            throw new Error(`${CONFIG_FILE} is not valid JSON — not overwriting it`);
        }
    }
    const merged = mergeIntendedConfig(existing, applied, options);
    await writeText(dir, CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n');
    return merged;
}

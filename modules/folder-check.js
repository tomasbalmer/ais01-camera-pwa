/*
 * What a device folder has to be, checked before a window is spent on it.
 *
 * This is the same argument `certmod.js` makes about the console line law: the
 * failure is invisible from the device end. A folder with the wrong material in
 * it produces writes that succeed, a modem that stores something, and a unit
 * that will not connect — discovered at ④ if you are lucky and in the field if
 * you are not. Every check below can be made on a laptop, in microseconds, with
 * no unit attached.
 *
 * So it refuses rather than warns, for the same reason `checkParts` does:
 * continuing only buys a more confusing failure later, and on a bench the cost
 * of being sent back to the file picker is one click.
 *
 * The exception is the password's shape, which is a NOTE. We know what it has
 * looked like on every unit so far; we do not know that it can never look
 * different, and refusing on a pattern nobody promised would be this file
 * inventing a rule.
 */

/*
 * The folder's NAME is where identity lives, because nothing inside carries it:
 * AWS names the PEMs after the certificate, not after the device.
 *
 *     AIS01-CB-869181072714122-WaterplanProduction
 *              └─── IMEI ────┘ └──── where ─────┘
 *
 * Two facts and no more. The region used to ride here as a `-AR` suffix and is
 * a file now — see `REGION_CODES`.
 */
export const FOLDER_IMEI = /(\d{15})/;
export const FOLDER_ENV = /(staging|production)/i;

/*
 * The convention spelled out, for telling somebody what to rename a folder to.
 * It sits beside the two patterns above so it cannot drift from them.
 */
export const FOLDER_SHAPE =
    'AIS01-CB-<15-digit IMEI>-Waterplan<Staging|Production>';

/* One sentence for both halves of the name — see the environment row. */
export const BAD_NAME = `BAD FOLDER NAME — expected ${FOLDER_SHAPE}`;

/*
 * The region is a FILE, not part of the name.
 *
 * `firmware-factory/docs/golden-config.md`: `AT+APN` is `em` on AR/EMnify and
 * `NULL` on BR/Vivo, `AT+IOTMOD` is 0 against 2. Those decide whether the modem
 * attaches at all, and nothing else in the folder knows which SIM the unit will
 * sit beside.
 *
 * It rode in the folder name for one version, as a `-AR` suffix. Two letters
 * anchored to the end of a name is a fragile place to keep a fact that changes
 * the APN: it is invisible in a file listing, it is lost by any rename, and it
 * made the name carry three things instead of two. `password.txt` had already
 * shown the shape for this — a fact that belongs to the unit, in a file of its
 * own, with nothing else in it.
 */
export const REGION_CODES = ['AR', 'BR'];

/*
 * The three facts, each on its own, present or not.
 *
 * Read separately rather than all-or-nothing, because a name that is missing
 * one of them still has the other two and the operator has to be told WHICH is
 * missing. "Carries no IMEI and no environment" is what you get from a function
 * that only knows how to succeed completely.
 */
export function nameFacts(folder) {
    const imei = (folder.match(FOLDER_IMEI) || [])[1] || null;
    const envName = (folder.match(FOLDER_ENV) || [])[1] || null;
    return {
        imei,
        environment: envName ? envName.toLowerCase() : null,
    };
}

/* Both facts, or nothing: each decides what the material MEANS, and material
 * that means nothing is material that can be written into the wrong unit. */
export function identityOf(folder) {
    const facts = nameFacts(folder);
    if (!facts.imei || !facts.environment) return null;
    return { ...facts, folder };
}

/*
 * Files are identified by the names the server gives them, never by order or
 * position — the prefix is the certificate ID, so only the suffix is ours to
 * match on.
 */
export const FILE_ROLES = [
    ['certificate', /-certificate\.pem\.crt$/i],
    ['private_key', /-private\.pem\.key$/i],
    ['password',    /^password\.txt$/i],
    /* Not from AWS. Ours, like password.txt, and required for the same reason:
     * without it ③ has no APN to send and the unit never attaches. */
    ['region',      /^region\.txt$/i],
];

/*
 * What to tell an operator who is missing one. The patterns above are for
 * matching; these are for reading, and they are what somebody types or looks
 * for in a file listing.
 *
 * The verdict in front of them is uppercase and the name itself is not. Every
 * one of these is a literal to be copied — a folder really is called
 * `WaterplanProduction` and a file really is called `password.txt` — so
 * shouting the name would be teaching the wrong one. Only the part that is a
 * judgement gets to shout.
 */
const WANTED = {
    certificate: '*-certificate.pem.crt',
    private_key: '*-private.pem.key',
    password: 'password.txt',
    region: `region.txt (${REGION_CODES.join(' or ')})`,
};

/*
 * Expected in the folder and not wanted. Named rather than lumped into
 * "everything else", so a folder full of files the app ignored can say WHY it
 * ignored them — `AmazonRootCA1.pem` is public and ships in this app's source,
 * and the public key is the one file the modem never sees.
 */
export const IGNORED = [
    [/^AmazonRootCA\d*\.pem$/i, 'public, ships in the app'],
    [/-public\.pem\.key$/i, 'the modem never sees it'],
    [/^\.DS_Store$/i, 'macOS'],
    [/^provisioning-log\.jsonl$/i, 'written by us'],
    [/^intended-config\.json$/i, 'written by us'],
    [/^provisioning-state\.json$/i, 'the CLI\'s'],
];

/*
 * The 64 hex characters AWS puts in front of both PEM names. It is the only
 * thing tying a certificate to its key, and comparing the two is the one check
 * that catches a folder holding material from two different certificates —
 * which writes without complaint and is refused by AWS IoT weeks later.
 */
const CERT_ID = /^([0-9a-f]{64})-/i;

export function certificateId(name) {
    const found = name.match(CERT_ID);
    return found ? found[1].toLowerCase() : null;
}

/*
 * Show the head and hide the tail.
 *
 * A certificate id is 64 hex characters and its file name is longer still.
 * Printed whole it is the widest thing on the screen and the least readable —
 * and the only use anyone has for it is comparing two of them, which the first
 * ten characters settle. Ten is also enough to tell one unit's material from
 * the next, which is the comparison this whole screen exists for.
 *
 * The dots are a fixed length rather than the real one. What is hidden is not
 * a secret and the exact count is not information anybody wants; a ragged right
 * edge across four lines is just noise.
 */
export function mask(text, keep = 10) {
    const body = String(text || '');
    if (body.length <= keep) return body;
    return body.slice(0, keep) + '·'.repeat(10);
}

/*
 * Shorten a file name by shrinking the part that is long, which is the
 * certificate id, and leaving the part that says what the file IS.
 *
 * Blind truncation was worse than no truncation for anything that is not an
 * AWS-generated name: `AmazonRootCA1.pem` came out as `AmazonRootC··········`,
 * longer than the original and no longer recognisable. Only a 64-hex prefix is
 * ever hidden, and the suffix that names the role always survives.
 */
export function shortName(name) {
    const id = certificateId(name);
    return id ? mask(id) + name.slice(id.length) : name;
}

/*
 * Is this PEM what it claims to be?
 *
 * Not cryptography — structure. It catches the failures a download actually
 * has: a truncated file, an HTML error page saved under a `.crt` name, a
 * zero-byte placeholder, and a certificate CHAIN where the modem expects one
 * certificate. `wireParts` would send any of them line by line and the checksum
 * gate would report a mismatch against a size we derived from the same bad
 * bytes, so nothing downstream can tell you what went wrong.
 */
export function pemProblem(text, expect) {
    const body = (text || '').trim();
    if (!body) return 'the file is empty';

    const labels = expect === 'certificate'
        ? ['CERTIFICATE']
        : ['RSA PRIVATE KEY', 'PRIVATE KEY', 'EC PRIVATE KEY'];

    const opened = labels.find(
        label => body.includes(`-----BEGIN ${label}-----`));
    if (!opened) {
        const first = body.split('\n')[0].slice(0, 48);
        return `no ${labels[0]} header — the file starts "${first}"`;
    }
    if (!body.includes(`-----END ${opened}-----`)) {
        return `the ${opened} block never ends — the file looks truncated`;
    }

    if (expect === 'certificate') {
        const blocks = body.split('-----BEGIN CERTIFICATE-----').length - 1;
        if (blocks > 1) {
            return `${blocks} certificates in one file — the BG95 slot takes ` +
                   'the device certificate alone, not a chain';
        }
    }

    /* Every line between the markers must be base64, or the bytes we checksum
     * are not the bytes anyone meant to send. */
    const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const inner = lines.slice(1, -1);
    if (!inner.length) return 'the block has no body between its markers';
    const bad = inner.find(line => !/^[A-Za-z0-9+/=]+$/.test(line));
    if (bad) return `a body line is not base64: "${bad.slice(0, 32)}"`;

    return null;
}

/* The console takes a 6-digit PIN. Anything else is the wrong file. */
const PASSWORD_SHAPE = /^\d{6}$/;

/* Both of our own files hold one value and nothing else, so both are read the
 * same way — trailing newline from an editor included. */
const firstLine = text => text.split(/\r?\n/)[0].trim();

/*
 * Sort the folder's files into the roles, and say when a role is ambiguous.
 *
 * Ambiguity used to resolve itself silently: the matcher took the first hit and
 * a folder holding last month's certificate alongside this month's wrote
 * whichever one the file system happened to list first. That is not a folder
 * the app gets to guess about.
 */
export function matchRoles(names) {
    const roles = {};
    for (const [role, pattern] of FILE_ROLES) {
        roles[role] = names.filter(name => pattern.test(name));
    }
    const claimed = new Set(Object.values(roles).flat());
    const ignored = [];
    const unknown = [];
    for (const name of names) {
        if (claimed.has(name)) continue;
        const rule = IGNORED.find(([pattern]) => pattern.test(name));
        if (rule) ignored.push([name, rule[1]]);
        else unknown.push(name);
    }
    return { roles, ignored, unknown };
}

/*
 * The whole verdict, as a list of findings the screen can print line by line.
 *
 * `files` are File-like: `{ name, text() }`. Returns
 * `{ ok, identity, chosen, password, findings }` — `chosen` is the one file per
 * role and `password` its first line, both present only when `ok`.
 */
export async function checkFolder(folder, files) {
    const findings = [];
    const say = (level, label, detail) => findings.push({ level, label, detail });
    let fatal = false;
    const bad = (label, detail) => { say('fail', label, detail); fatal = true; };

    /* ── The name ──────────────────────────────────────────────────────── */
    const facts = nameFacts(folder);

    /* First row, and green: picking a folder at all is the one thing that has
     * definitely gone right by the time this runs, and a screen of red with no
     * green in it does not tell you where you are. The browser never hands over
     * a path — only this name — so this is the whole of what can be shown. */
    say('ok', 'folder selected', folder);

    if (facts.imei) say('ok', 'imei', facts.imei);
    else bad('imei', BAD_NAME);

    if (facts.environment) say('ok', 'environment', facts.environment);
    /* The same sentence as the IMEI row above, deliberately. They are two
     * halves of one name, and an operator fixing either one is renaming the
     * same directory to the same shape — two different instructions for one
     * action is how you get a folder that satisfies neither. */
    else bad('environment', BAD_NAME);

    /* ── The files ─────────────────────────────────────────────────────── */
    const { roles, ignored, unknown } = matchRoles(files.map(f => f.name));
    const chosen = {};
    let password = null;
    let region = null;

    for (const [role] of FILE_ROLES) {
        const hits = roles[role];

        if (!hits.length) {
            bad(role, `MISSING FILE — expected ${WANTED[role]}`);
            continue;
        }
        if (hits.length > 1) {
            bad(role, `TOO MANY FILES — expected one ${WANTED[role]}, found ` +
                      `${hits.length}: ${hits.map(shortName).join(' and ')}`);
            continue;
        }

        const file = files.find(f => f.name === hits[0]);
        const text = await file.text();

        if (role === 'password') {
            password = firstLine(text);
            if (!password) {
                bad(role, `${file.name} is empty — download it again from Drive`);
                continue;
            }
            /*
             * A refusal, not a warning. It was a warning on the reasoning that
             * we know what these have looked like and not that they can never
             * look otherwise — true, and the wrong trade: the console takes a
             * 6-digit PIN, so anything else is a file that will fail ① after
             * costing an AT window to find out. Being sent back to the folder
             * is cheaper than being sent back to the bench.
             */
            if (!PASSWORD_SHAPE.test(password)) {
                bad(role, `${file.name} holds ${password.length} characters — ` +
                          'the console password is 6 digits, so this is the ' +
                          'wrong file or the wrong contents');
                continue;
            }
            /* The value never appears. The shape is the whole of what can be
             * said safely in a log people screenshot. */
            say('ok', role, `${file.name} found with 6 digits`);
            chosen[role] = file;
            continue;
        }

        if (role === 'region') {
            region = firstLine(text).toUpperCase();
            if (!region) {
                bad(role, `${file.name} is empty — it holds the country code, ` +
                          `${REGION_CODES.join(' or ')}`);
                continue;
            }
            if (!REGION_CODES.includes(region)) {
                bad(role, `${file.name} holds "${region}" — there is no network ` +
                          `profile for it, only ${REGION_CODES.join(' and ')}`);
                continue;
            }
            say('ok', role, `${region} — the network profile ③ will send`);
            chosen[role] = file;
            continue;
        }

        const problem = pemProblem(text, role);
        if (problem) { bad(role, problem); continue; }
        say('ok', role, `${shortName(file.name)} found, ${text.length} bytes`);
        chosen[role] = file;
    }

    /* ── The tie between the two PEMs ──────────────────────────────────── */
    const certId = chosen.certificate && certificateId(chosen.certificate.name);
    const keyId = chosen.private_key && certificateId(chosen.private_key.name);

    /*
     * The one thing neither row above can say.
     *
     * `CERTIFICATE` and `PRIVATE KEY` each judge one file on its own: it is
     * there, it is a PEM, it is this many bytes. Both can pass on a certificate
     * from unit A and a key from unit B — the write succeeds and AWS IoT
     * refuses the handshake a cycle later, because a key that does not match
     * its certificate is not something either file can be asked about alone.
     * Only their two names, compared, can answer it.
     *
     * So this speaks when the answer is not already on the screen. Both rows
     * print the id they carry, so two matching ids are visible in the two rows
     * above and a third row saying "these match" is the screen telling you
     * something you just read. What is NOT visible up there is a mismatch that
     * you have to notice yourself, or a pair that could not be compared at all.
     *
     * That is not the usual "silence reads as a pass" trap: the evidence is
     * printed either way. This row restates it or it does not.
     */
    if (chosen.certificate && chosen.private_key) {
        if (certId && keyId && certId !== keyId) {
            bad('cert + key', `certificate is ${mask(certId)} but the key is ` +
                              `${mask(keyId)} — two different certificates`);
            findings[findings.length - 1].rule = true;
        } else if (!certId || !keyId) {
            /* Worth one line: the guard is off, and it is the guard that
             * catches the mistake this whole screen exists to catch. */
            say('info', 'cert + key',
                'not compared — the names carry no certificate id, so they ' +
                'were renamed after AWS created them');
            findings[findings.length - 1].rule = true;
        }
    }

    for (const [name, why] of ignored) {
        say('info', 'ignored', `${shortName(name)} — ${why}`);
    }
    for (const name of unknown) {
        say('info', 'also present', shortName(name));
    }

    return {
        ok: !fatal,
        identity: fatal ? null : { ...facts, folder },
        chosen: fatal ? null : chosen,
        password: fatal ? null : password,
        region: fatal ? null : region,
        findings,
    };
}

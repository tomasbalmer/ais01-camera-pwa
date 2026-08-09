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
 */
export const FOLDER_IMEI = /(\d{15})/;
export const FOLDER_ENV = /(staging|production)/i;

/*
 * The region, and it is a third fact the folder has to carry.
 *
 * `firmware-factory/docs/golden-config.md`: `AT+APN` is `em` on AR/EMnify and
 * `NULL` on BR/Vivo, and `AT+IOTMOD` is 0 against 2. Those are the settings a
 * unit needs to attach at all, and nothing inside the folder says which set
 * applies — the certificate does not know what SIM it will sit beside.
 *
 * Anchored to the end, because `AR` and `BR` are two letters and an unanchored
 * match would find them inside a word somebody put in the middle of a name.
 *
 *     AIS01-CB-869181072714122-WaterplanProduction-AR
 *              └─── IMEI ────┘ └──── where ─────┘ └┘ which network
 */
export const FOLDER_REGION = /-(AR|BR)\s*$/i;

export function identityOf(folder) {
    const imei = (folder.match(FOLDER_IMEI) || [])[1];
    const envName = (folder.match(FOLDER_ENV) || [])[1];
    if (!imei || !envName) return null;
    const region = (folder.match(FOLDER_REGION) || [])[1];
    return {
        imei,
        environment: envName.toLowerCase(),
        /* Null is a real answer here and not a failure: everything except the
         * network stage works without it. */
        region: region ? region.toUpperCase() : null,
        folder,
    };
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
];

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
 * A file list for the log. Masked like everything else here — these are the
 * same 64-hex names, and the reason to print them at all is so a folder full
 * of files the app skipped can say which ones, not so anyone reads the ids.
 */
function listNames(entries) {
    return entries
        .map(entry => Array.isArray(entry)
            ? `${mask(entry[0])} (${entry[1]})`
            : mask(entry))
        .join(', ');
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

/* What every unit's password has looked like so far. A NOTE, never a refusal
 * — see the header. */
const PASSWORD_SHAPE = /^\d{6}$/;

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

    const identity = identityOf(folder);
    if (!identity) {
        say('fail', 'name', `"${folder}" carries no IMEI and no environment`);
        return { ok: false, identity: null, chosen: null, findings };
    }
    say('ok', 'name', `IMEI ${identity.imei}, ${identity.environment}`);

    /*
     * A note, not a refusal. The certificates, the login and the MQTT settings
     * do not care which network the unit will attach to; only the network
     * stage does, and it is the one that refuses.
     */
    if (identity.region) {
        say('ok', 'region', `${identity.region} — the network profile ③ will send`);
    } else {
        say('note', 'region',
            'the folder name does not end in -AR or -BR, so the network stage ' +
            'has no APN or IOTMOD to send — rename it to enable that stage');
    }

    const { roles, ignored, unknown } = matchRoles(files.map(f => f.name));

    /* Presence and ambiguity, before anything is read. */
    let fatal = false;
    for (const [role] of FILE_ROLES) {
        const hits = roles[role];
        if (!hits.length) {
            say('fail', role, 'missing');
            fatal = true;
        } else if (hits.length > 1) {
            say('fail', role, `${hits.length} candidates — ${hits.join(', ')}`);
            fatal = true;
        }
    }
    if (fatal) {
        if (ignored.length) {
            say('info', 'ignored', listNames(ignored));
        }
        if (unknown.length) say('info', 'also present', listNames(unknown));
        return { ok: false, identity, chosen: null, findings };
    }

    const chosen = Object.fromEntries(FILE_ROLES.map(([role]) => [
        role, files.find(f => f.name === roles[role][0]),
    ]));

    /* The pair. Both names carry the certificate they belong to, and material
     * from two different certificates is the failure that writes cleanly and
     * is refused by AWS IoT a cycle later. */
    const certId = certificateId(chosen.certificate.name);
    const keyId = certificateId(chosen.private_key.name);
    if (certId && keyId && certId !== keyId) {
        say('fail', 'pair',
            `certificate is ${mask(certId)} but the key is ${mask(keyId)} — ` +
            'two different certificates in one folder');
        fatal = true;
    } else if (certId && keyId) {
        say('ok', 'pair',
            `certificate and key both from ${mask(certId)}`);
    } else {
        /* Renamed by hand, so the tie cannot be checked. Not a refusal — the
         * files may be perfectly correct — but it is the check that would have
         * caught a mixed folder, and its absence is worth one line. */
        say('info', 'pair',
            'file names carry no certificate id, so the two cannot be tied ' +
            'together — they were renamed after AWS created them');
    }

    /* Contents. */
    const certText = await chosen.certificate.text();
    const certBad = pemProblem(certText, 'certificate');
    if (certBad) { say('fail', 'certificate', certBad); fatal = true; }
    else say('ok', 'certificate',
             `${mask(chosen.certificate.name)} found, ${certText.length} bytes`);

    const keyText = await chosen.private_key.text();
    const keyBad = pemProblem(keyText, 'private_key');
    if (keyBad) { say('fail', 'private key', keyBad); fatal = true; }
    else say('ok', 'private key',
             `${mask(chosen.private_key.name)} found, ${keyText.length} bytes`);

    const password = (await chosen.password.text()).split(/\r?\n/)[0].trim();
    if (!password) {
        say('fail', 'password', 'password.txt is empty');
        fatal = true;
    } else if (!PASSWORD_SHAPE.test(password)) {
        say('note', 'password',
            `${chosen.password.name} found with ${password.length} characters ` +
            '— every unit so far has had 6 digits, so check this is the ' +
            'console password and not something else');
    } else {
        /* The value never appears. The shape is what the operator needs to
         * know, and it is the whole of what can be said safely. */
        say('ok', 'password',
            `${chosen.password.name} found with 6 digits`);
    }

    if (ignored.length) say('info', 'ignored', listNames(ignored));
    if (unknown.length) say('info', 'also present', listNames(unknown));

    return {
        ok: !fatal,
        identity,
        chosen: fatal ? null : chosen,
        password: fatal ? null : password,
        findings,
    };
}

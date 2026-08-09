/*
 * folder-check.js.  Run:  node modules/folder-check.test.mjs
 *
 * Every check in that module exists because the failure it catches is invisible
 * from the device end: the writes succeed, the modem stores something, and the
 * unit is refused by AWS IoT a cycle later or in the field. So the tests are
 * about what gets REFUSED — a check that passes bad material is worth nothing,
 * and one that refuses good material costs a bench session.
 */

import {
    identityOf, matchRoles, certificateId, pemProblem, checkFolder, mask,
} from './folder-check.js';

let failed = 0;
const check = (name, actual, expected) => {
    const okay = JSON.stringify(actual) === JSON.stringify(expected);
    if (!okay) failed++;
    console.log(`${okay ? 'ok  ' : 'FAIL'} ${name}` +
        (okay ? '' : `\n       expected ${JSON.stringify(expected)}` +
                     `\n       got      ${JSON.stringify(actual)}`));
};

const file = (name, text) => ({ name, text: async () => text });

const ID_A = 'dd1a1d7b3b299a525c01eba6640e579ea43bccf066b7cd46a06110accc1db760';
const ID_B = '8ae2b66303d65501b1f2e1481fd66f628b0df3c39cb0c140fc58e78283ac0a3c';
const FOLDER = 'AIS01-CB-869181072714122-WaterplanProduction';

const CERT = ['-----BEGIN CERTIFICATE-----',
    'MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF',
    '-----END CERTIFICATE-----'].join('\n');
const KEY = ['-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy',
    '-----END RSA PRIVATE KEY-----'].join('\n');

const goodFolder = () => [
    file(`${ID_A}-certificate.pem.crt`, CERT),
    file(`${ID_A}-private.pem.key`, KEY),
    file('password.txt', '482913\n'),
    file('AmazonRootCA1.pem', CERT),
    file(`${ID_A}-public.pem.key`, KEY),
];

/* ── Identity ────────────────────────────────────────────────────────────
 * The folder's name is the only place the IMEI and the environment exist. */
check('the name yields the facts it carries', identityOf(FOLDER),
      { imei: '869181072714122', environment: 'production', region: null,
        folder: FOLDER });

/* The region is a third fact, and the two letters are anchored to the end —
 * unanchored, `AR` and `BR` turn up inside ordinary words. */
check('a region suffix is read', identityOf(`${FOLDER}-AR`).region, 'AR');
check('lowercase is normalised', identityOf(`${FOLDER}-br`).region, 'BR');
check('AR inside a word is not a region',
      identityOf('AIS01-CB-869181072714122-WaterplanProduction-SPARE').region,
      null);
check('a folder with no region still yields an identity',
      identityOf(FOLDER) !== null, true);
check('a name with no environment is not an identity',
      identityOf('AIS01-CB-869181072714122'), null);
check('a name with no IMEI is not an identity',
      identityOf('WaterplanProduction'), null);

/* ── Roles ─────────────────────────────────────────────────────────────── */
const sorted = matchRoles([
    `${ID_A}-certificate.pem.crt`, `${ID_A}-private.pem.key`, 'password.txt',
    'AmazonRootCA1.pem', `${ID_A}-public.pem.key`, 'notes.md',
]);
check('the public key is ignored, not unknown',
      sorted.ignored.map(([n]) => n).includes(`${ID_A}-public.pem.key`), true);
check('an unexpected file is reported rather than swallowed',
      sorted.unknown, ['notes.md']);

check('the certificate id is read off the name',
      certificateId(`${ID_A}-certificate.pem.crt`), ID_A);
check('a renamed file has no id to read', certificateId('cert.pem.crt'), null);

/* Masking is display, not security — what is hidden is not a secret. It exists
 * so four lines of 64-hex do not become the widest thing on the screen, and it
 * keeps the ten characters that settle the only question anyone asks of an id:
 * is this the same one as that. */
check('an id keeps the ten that let you compare it',
      mask(ID_A).startsWith('dd1a1d7b3b'), true);
check('and hides the rest at a fixed width',
      mask(ID_A), 'dd1a1d7b3b··········');
check('two different ids stay different once masked',
      mask(ID_A) === mask(ID_B), false);
check('something already short is left alone', mask('482913'), '482913');
check('and nothing is not a crash', mask(null), '');

/* ── PEM shape ───────────────────────────────────────────────────────────
 * What a download actually does when it goes wrong. */
check('a good certificate has no problem', pemProblem(CERT, 'certificate'), null);
check('a good key has no problem', pemProblem(KEY, 'private_key'), null);
check('an empty file is caught', pemProblem('   ', 'certificate'),
      'the file is empty');
check('an HTML error page saved as .crt is caught',
      /no CERTIFICATE header/.test(
          pemProblem('<!DOCTYPE html><title>404</title>', 'certificate')), true);
check('a truncated block is caught',
      /truncated/.test(pemProblem(
          '-----BEGIN CERTIFICATE-----\nMIIDQTCC\n', 'certificate')), true);
check('a chain is caught — the BG95 slot takes one certificate',
      /2 certificates/.test(pemProblem(CERT + '\n' + CERT, 'certificate')), true);
check('a non-base64 body line is caught',
      /not base64/.test(pemProblem(
          '-----BEGIN CERTIFICATE-----\nnot base64 at all!\n-----END CERTIFICATE-----',
          'certificate')), true);
check('a PKCS#8 key is accepted too',
      pemProblem(KEY.replace(/RSA PRIVATE KEY/g, 'PRIVATE KEY'), 'private_key'),
      null);

/* ── The whole folder ──────────────────────────────────────────────────── */
const good = await checkFolder(FOLDER, goodFolder());
check('a correct folder passes', good.ok, true);
/* A missing region is a NOTE: the certificates, the login and the MQTT
 * settings do not care which SIM the unit will sit beside. Only ③ does. */
check('a folder with no region still loads', good.ok, true);
check('but the network stage is warned about',
      good.findings.some(f => f.level === 'note' && f.label === 'region'), true);
check('and hands back the password, not the file', good.password, '482913');

/* The password's VALUE is never in a finding — the shape is the whole of what
 * can be said safely, and the log is a thing people screenshot. */
const passwordLine = good.findings.find(f => f.label === 'password');
check('the password line says the shape', passwordLine.detail,
      'password.txt found with 6 digits');
check('and never the value',
      good.findings.some(f => f.detail.includes('482913')), false);

/* Neither is a full certificate id. */
check('the certificate line is masked',
      good.findings.some(f => f.detail.includes(ID_A)), false);
check('and the certificate it chose',
      good.chosen.certificate.name, `${ID_A}-certificate.pem.crt`);

/*
 * The check this module was written for. A folder holding material from two
 * different certificates writes without complaint and is refused by AWS IoT a
 * cycle later — nothing before ④ can tell you.
 */
const mixed = await checkFolder(FOLDER, [
    file(`${ID_A}-certificate.pem.crt`, CERT),
    file(`${ID_B}-private.pem.key`, KEY),
    file('password.txt', '482913'),
]);
check('material from two certificates is refused', mixed.ok, false);
check('and the reason names both',
      mixed.findings.some(f => f.level === 'fail' && f.label === 'pair'), true);

/*
 * Ambiguity used to resolve itself silently — the matcher took the first hit,
 * so a folder holding last month's certificate wrote whichever the file system
 * listed first.
 */
const ambiguous = await checkFolder(FOLDER, [
    file(`${ID_A}-certificate.pem.crt`, CERT),
    file(`${ID_B}-certificate.pem.crt`, CERT),
    file(`${ID_A}-private.pem.key`, KEY),
    file('password.txt', '482913'),
]);
check('two candidates for one role are refused, not guessed at',
      ambiguous.ok, false);
check('and both names are shown',
      ambiguous.findings.some(f => f.detail.includes('2 candidates')), true);

const noKey = await checkFolder(FOLDER, [
    file(`${ID_A}-certificate.pem.crt`, CERT),
    file('password.txt', '482913'),
]);
check('a missing role is refused', noKey.ok, false);
check('and named exactly',
      noKey.findings.some(f => f.label === 'private_key' && f.detail === 'missing'),
      true);

const emptyPassword = await checkFolder(FOLDER, [
    file(`${ID_A}-certificate.pem.crt`, CERT),
    file(`${ID_A}-private.pem.key`, KEY),
    file('password.txt', '\n'),
]);
check('an empty password.txt is refused', emptyPassword.ok, false);

/* A password of an unexpected shape is a NOTE. We know what they have looked
 * like; we do not know they can never look otherwise. */
const oddPassword = await checkFolder(FOLDER, [
    file(`${ID_A}-certificate.pem.crt`, CERT),
    file(`${ID_A}-private.pem.key`, KEY),
    file('password.txt', 'hunter2!'),
]);
check('an unusual password is allowed through', oddPassword.ok, true);
check('but it is called out',
      oddPassword.findings.some(f => f.level === 'note' && f.label === 'password'),
      true);

/*
 * A folder whose files were renamed by hand loses the tie between certificate
 * and key. That is not a refusal — the files may be perfectly correct — but the
 * missing check is worth a line.
 *
 * The rename has to keep the ROLE suffix: that suffix is what says which file
 * is which, so `cert.pem.crt` is not a renamed certificate, it is a file this
 * app has no way to recognise. Only the certificate-id prefix is expendable.
 */
const renamed = await checkFolder(FOLDER, [
    file('unit122-certificate.pem.crt', CERT),
    file('unit122-private.pem.key', KEY),
    file('password.txt', '482913'),
]);
check('hand-renamed files still load', renamed.ok, true);
check('but the untestable tie is said out loud',
      renamed.findings.some(f => f.label === 'pair' && f.level === 'info'), true);

/* A folder is judged in full even when it fails: knowing which line broke is
 * the difference between re-downloading one file and re-downloading all. */
check('a failing folder still reports every check it got to',
      mixed.findings.length >= 3, true);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

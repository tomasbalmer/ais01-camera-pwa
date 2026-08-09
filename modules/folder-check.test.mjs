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
    shortName, FOLDER_SHAPE, BAD_NAME,
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
    file('region.txt', 'AR\n'),
    file('AmazonRootCA1.pem', CERT),
    file(`${ID_A}-public.pem.key`, KEY),
];

/* ── Identity ────────────────────────────────────────────────────────────
 * The folder's name is the only place the IMEI and the environment exist. */
check('the name yields the two facts it carries', identityOf(FOLDER),
      { imei: '869181072714122', environment: 'production', folder: FOLDER });

/* The region left the name. It changes the APN, and two letters anchored to
 * the end of a directory are invisible in a listing and lost by any rename. */
check('the name carries no region any more',
      'region' in identityOf(FOLDER), false);
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
check('the region comes off its own file', good.region, 'AR');
check('and reads as a row like any other',
      good.findings.some(f => f.level === 'ok' && f.label === 'region'), true);
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
      mixed.findings.some(f => f.level === 'fail' && f.label === 'cert + key'),
      true);

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
      ambiguous.findings.some(f => f.detail.startsWith('TOO MANY FILES')
                                && f.detail.includes(' and ')), true);

const noKey = await checkFolder(FOLDER, [
    file(`${ID_A}-certificate.pem.crt`, CERT),
    file('password.txt', '482913'),
]);
check('a missing role is refused', noKey.ok, false);
check('and named exactly, with what would fix it',
      noKey.findings.find(f => f.label === 'private_key').detail,
      'MISSING FILE — expected *-private.pem.key');

const emptyPassword = await checkFolder(FOLDER, [
    file(`${ID_A}-certificate.pem.crt`, CERT),
    file(`${ID_A}-private.pem.key`, KEY),
    file('password.txt', '\n'),
]);
check('an empty password.txt is refused', emptyPassword.ok, false);

/* A password that is not six digits is the wrong file or the wrong contents,
 * and finding that out at ① costs an AT window. */
const oddPassword = await checkFolder(FOLDER,
    goodFolder().map(f => f.name === 'password.txt' ? file(f.name, 'hunter2!') : f));
check('a password that is not 6 digits is refused', oddPassword.ok, false);

/* ── region.txt ───────────────────────────────────────────────────────── */
const noRegion = await checkFolder(FOLDER,
    goodFolder().filter(f => f.name !== 'region.txt'));
check('a folder with no region.txt is refused', noRegion.ok, false);
check('and the row names the file and its contents',
      noRegion.findings.find(f => f.label === 'region').detail,
      'MISSING FILE — expected region.txt (AR or BR)');

const badRegion = await checkFolder(FOLDER,
    goodFolder().map(f => f.name === 'region.txt' ? file(f.name, 'US') : f));
check('a country with no profile is refused', badRegion.ok, false);
check('rather than silently sending the wrong APN',
      badRegion.findings.find(f => f.label === 'region').detail.includes('"US"'),
      true);

const lowerRegion = await checkFolder(FOLDER,
    goodFolder().map(f => f.name === 'region.txt' ? file(f.name, 'br\n') : f));
check('case and a trailing newline are not the operator\'s problem',
      lowerRegion.region, 'BR');

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
    file('region.txt', 'AR'),
]);
check('hand-renamed files still load', renamed.ok, true);
check('but the untestable tie is said out loud',
      renamed.findings.some(f => f.label === 'cert + key' && f.level === 'info'),
      true);

/* A folder is judged in full even when it fails: knowing which line broke is
 * the difference between re-downloading one file and re-downloading all. */
check('a failing folder still reports every check it got to',
      mixed.findings.length >= 3, true);


/* ── Every row, every time ───────────────────────────────────────────────
 *
 * The check used to return on the first failure, so a folder with a bad NAME
 * reported one line and stopped — and the operator fixing it could not see
 * which files were already in place. A checklist that stops at the first
 * unticked box is not a checklist.
 */
/* Every row a folder must produce. `cert + key` is not among them: it speaks
 * only when the two ids disagree or cannot be read, because when they agree
 * both rows above already print the id and a third saying so is the screen
 * repeating what you just read. */
const ROWS = ['folder selected', 'imei', 'environment',
              'certificate', 'private_key', 'password', 'region'];
const labelsOf = report => report.findings.map(f => f.label);

check('a good folder reports every row',
      ROWS.every(row => labelsOf(good).includes(row)), true);

const nameless = await checkFolder('AIS01-CB-Test', goodFolder());
check('a folder with an unusable name is refused', nameless.ok, false);
check('and still reports every row',
      ROWS.every(row => labelsOf(nameless).includes(row)), true);
check('naming the IMEI as the thing that is missing',
      nameless.findings.some(f => f.label === 'imei' && f.level === 'fail'), true);
check('and the environment separately',
      nameless.findings.some(f => f.label === 'environment' && f.level === 'fail'),
      true);
check('while the files it DOES have still come back ok',
      nameless.findings.filter(f => f.level === 'ok').map(f => f.label).sort(),
      ['certificate', 'folder selected', 'password', 'private_key', 'region']);

/* The folder is the first row and it is green: picking one is the thing that
 * has definitely gone right, and a screen of red with no green in it does not
 * tell you where you are. */
check('the folder leads, in its own row', nameless.findings[0],
      { level: 'ok', label: 'folder selected', detail: 'AIS01-CB-Test' });

/* A row that says what is wrong without saying what right looks like leaves
 * the operator to reconstruct the convention from three other rows. */
/* The verdict shouts and the literal does not: every one of these names is
 * something to be copied, and a shouted `WATERPLANPRODUCTION` teaches a folder
 * name that does not exist. */
check('a bad name says what right looks like, and briefly',
      nameless.findings.find(f => f.label === 'imei').detail, BAD_NAME);
check('and the verdict is the only part shouting',
      BAD_NAME, `BAD FOLDER NAME — expected ${FOLDER_SHAPE}`);
check('both halves of the name give the same instruction, because it is one ' +
      'rename', nameless.findings.find(f => f.label === 'environment').detail,
      BAD_NAME);

/* One fact missing is one row failing, not all of them. */
const noRegionNoEnv = await checkFolder('AIS01-CB-869181072714122', goodFolder());
check('the IMEI is found even when the environment is not',
      noRegionNoEnv.findings.some(f => f.label === 'imei' && f.level === 'ok'),
      true);
check('and only the environment fails',
      noRegionNoEnv.findings.filter(f => f.level === 'fail').map(f => f.label),
      ['environment']);

/* ── One row per thing ───────────────────────────────────────────────────
 * A grouped line cannot say which of its members is there and which is not,
 * which is the whole reason to read the list. */
const extras = await checkFolder(FOLDER, [
    ...goodFolder(),
    file('AmazonRootCA3.pem', CERT),
    file('.DS_Store', ''),
    file('notes.md', 'x'),
]);
check('every ignored file gets its own row',
      extras.findings.filter(f => f.label === 'ignored').length, 4);
check('and so does every unexpected one',
      extras.findings.filter(f => f.label === 'also present').length, 1);
/* The claim is one FILE per row, not one comma — the reasons are prose and
 * "public, ships in the app" is allowed a comma of its own. */
check('and each row names exactly one file, with its reason',
      extras.findings.filter(f => f.label === 'ignored')
          .map(f => f.detail.split(' — ')[0]).sort(),
      ['.DS_Store', 'AmazonRootCA1.pem', 'AmazonRootCA3.pem',
       'dd1a1d7b3b··········-public.pem.key']);

/* Shortening is for the 64-hex id and nothing else. Blind truncation made
 * `AmazonRootCA1.pem` into something longer and unrecognisable. */
check('a name with no id is left alone', shortName('AmazonRootCA1.pem'),
      'AmazonRootCA1.pem');
check('a name with one keeps the suffix that says what it is',
      shortName(`${ID_A}-certificate.pem.crt`),
      'dd1a1d7b3b··········-certificate.pem.crt');

const empty = await checkFolder('AIS01-CB-Test', []);
check('an empty folder names all four files it wants',
      ['certificate', 'private_key', 'password', 'region'].every(role =>
          empty.findings.some(f => f.label === role
                                && f.detail.startsWith('MISSING FILE'))),
      true);
/*
 * The row is dropped when there is nothing to compare. It could only restate
 * the MISSING FILE two lines above it, and its silence cannot be read as a
 * pass — it only ever goes quiet directly under the failure that explains it.
 */
check('and does not restate the missing PEMs as an uncomparable pair',
      empty.findings.some(f => f.label === 'cert + key'), false);

/* A folder whose two ids agree says so by printing the same id twice, in the
 * rows that were going to print it anyway. */
check('a matching pair adds no row of its own',
      good.findings.some(f => f.label === 'cert + key'), false);
check('because both rows already carry the id',
      ['certificate', 'private_key'].every(role =>
          good.findings.find(f => f.label === role).detail.includes(mask(ID_A))),
      true);

/* A mismatch is not visible unless you compare two masked ids yourself, so
 * that one gets said out loud — and ruled off, since it is a different
 * question from the rows above it. */
check('a mismatch is marked as a change of subject',
      mixed.findings.find(f => f.label === 'cert + key').rule, true);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

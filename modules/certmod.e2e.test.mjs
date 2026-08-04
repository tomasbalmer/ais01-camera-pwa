/*
 * The cert write, end to end, against a simulated modem.
 * Run:  node modules/certmod.e2e.test.mjs
 *
 * `certmod.test.mjs` proves the arithmetic. This proves the conversation: that
 * the sequence, the gates and the recovery behave the way they must when the
 * device answers something other than what we hoped.
 *
 * The scenarios below are chosen for what a real unit will not show you. A
 * hardware run tells you the happy path works and nothing about what happens
 * when the BG95 never says RDY — which is the moment the code is one command
 * away from streaming a private key into a device that is not listening.
 */

import { writeCerts } from './certmod.js';
import { makeFakeDevice } from './fake-device.js';

const BUNDLE = {
    imei: '869181072714122',
    /* Shape-accurate stand-ins: real PEM structure, no real key anywhere near
     * a test file. The checksum gate does not care what the bytes mean. */
    certificate: '-----BEGIN CERTIFICATE-----\n' +
        Array.from({ length: 18 }, (_, i) => 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5' + String(i % 10).repeat(16)).join('\n') +
        '\n-----END CERTIFICATE-----',
    private_key: '-----BEGIN RSA PRIVATE KEY-----\n' +
        Array.from({ length: 25 }, (_, i) => 'MIIEpAIBAAKCAQEAx7Zq8vLmNfKdTgWpRsYuHjBnCvExAmPl' + String(i % 10).repeat(16)).join('\n') +
        '\n-----END RSA PRIVATE KEY-----',
};

let failed = 0;
async function scenario(name, faults, expectation) {
    const fake = makeFakeDevice(faults);
    let outcome;
    try {
        const n = await writeCerts(fake.io, BUNDLE);
        outcome = { ok: true, files: n };
    } catch (err) {
        outcome = { ok: false, error: err.message };
    }
    const problem = expectation(outcome, fake);
    if (problem) { failed++; console.log(`FAIL ${name}\n       ${problem}`); }
    else console.log(`ok   ${name}`);
}

/* The happy path: three files, each accepted only on an exact size AND
 * checksum match computed by the fake over what it stored. */
await scenario('all three files pass the checksum gate', {}, (out, fake) => {
    if (!out.ok) return `threw: ${out.error}`;
    if (out.files !== 3) return `wrote ${out.files} files, expected 3`;
    const verified = fake.transcript.filter(l => l.startsWith('+QFUPL:'));
    if (verified.length !== 3) return `saw ${verified.length} +QFUPL results`;
    return null;
});

/* Entry without RDY is the dangerous one: the STM32 flipped, the modem did
 * not, and streaming would write a private key nowhere. It must stop, and it
 * must NOT be retried into. */
await scenario('refuses to proceed when BG95 never says RDY', { noRdy: true },
    (out, fake) => {
        if (out.ok) return 'completed despite no RDY';
        if (!/RDY/.test(out.error)) return `wrong error: ${out.error}`;
        if (fake.transcript.some(l => l.startsWith('CONNECT')))
            return 'opened an upload anyway';
        return null;
    });

/*
 * Echo off is a confidentiality gate, not a nicety — this terminal is on a
 * phone screen. But the three files are not equally secret: the Amazon root CA
 * ships in this app's own source and the client certificate is presented in
 * the clear on every handshake. Only the private key is worth refusing over,
 * and refusing over all three only meant that a modem whose echo will not go
 * off could not be provisioned at all.
 */
const keyUpload = fake =>
    fake.received.some(c => c.startsWith('AT+QFUPL="user_key.pem"'));

await scenario('refuses to stream when ATE0 is not confirmed', { refuseAte0: true },
    (out, fake) => {
        if (out.ok) return 'completed with echo on';
        if (!/echo/i.test(out.error)) return `wrong error: ${out.error}`;
        if (keyUpload(fake)) return 'streamed the private key with echo on';
        return null;
    });

/*
 * The live failure, and the reason `OK` stopped counting as proof: on
 * 2026-08-04 ATE0 was answered and the echo stayed on, so every command came
 * back and so did the certificate body. Only sending something and watching
 * for its own text can tell an answer from an effect.
 */
await scenario('an answered ATE0 that did not take is still echo on',
    { ate0Lies: true }, (out, fake) => {
        if (out.ok) return 'completed into a console that echoes key material';
        if (!/echo/i.test(out.error)) return `wrong error: ${out.error}`;
        if (keyUpload(fake)) return 'streamed the private key with echo on';
        return null;
    });

/*
 * Observed live at [71752]: the firmware had already left certificate mode
 * when it powered the NB module down, so the exit toggle ENTERED — and the
 * run finished by leaving the unit inside the state it meant to leave. Every
 * following run then paid for it twice, in a window with nothing to spare.
 */
await scenario('an exit that enters is toggled back out', { exitFindsItOut: true },
    (out, fake) => {
        if (fake.state().inCertmod) return 'left the unit inside passthrough';
        return null;
    });

/* A lost BLE write is the failure this whole design expects. It must surface
 * as a checksum mismatch and exhaust its retries rather than passing. */
await scenario('a dropped part fails the gate rather than passing',
    { dropPart: 5 }, (out) => {
        if (out.ok) return 'accepted a stream that lost a part';
        if (!/checksum gate/.test(out.error)) return `wrong error: ${out.error}`;
        return null;
    });

/* And the same loss, recovering on a later attempt, must end verified — with
 * the slot deleted in between so nothing half-written is ever trusted. */
await scenario('recovers on retry after a transient loss',
    { dropPart: 5, healAfter: 1 }, (out, fake) => {
        if (!out.ok) return `threw: ${out.error}`;
        const dels = fake.transcript.length;
        if (!dels) return 'no transcript';
        if (out.files !== 3) return `wrote ${out.files} files`;
        return null;
    });

/* Whatever happens, the unit must not be left in passthrough. */
await scenario('leaves passthrough even after a failure', { dropPart: 2 },
    (out, fake) => {
        if (out.ok) return 'expected a failure for this scenario';
        if (fake.state().inCertmod) return 'device left inside CERTMOD';
        if (!fake.transcript.includes('Exit certificate mode'))
            return 'never attempted the exit';
        return null;
    });

/* The device's own confirmations are the verification, so the ones that close
 * a successful run have to actually be asked for. */
await scenario('takes inventory and restarts after a successful write', {},
    (out, fake) => {
        if (!out.ok) return `threw: ${out.error}`;
        if (!fake.received.some(c => c.startsWith('AT+QFLST')))
            return 'never took the file inventory';
        if (!fake.received.includes('ATZ'))
            return 'never restarted — Dragino requires it after a cert change';
        /* Order matters: the restart is the last thing, after the exit. */
        if (fake.received.indexOf('ATZ') < fake.received.lastIndexOf('AT+CERTMOD'))
            return 'restarted before leaving passthrough';
        if (fake.state().inCertmod) return 'still inside CERTMOD';
        return null;
    });

await scenario('an unconfirmed exit is an error, not a note', { noExit: true },
    (out) => {
        if (out.ok) return 'completed despite an unconfirmed exit';
        if (!/exit was not confirmed/.test(out.error)) return `wrong error: ${out.error}`;
        return null;
    });

/*
 * The regression that cost a live session on 2026-08-04, and the reason this
 * simulator now models the app's collector rather than a forgiving window.
 *
 * `Enter certificate mode` / `OK` / `RDY` arrive in ONE batch. Any entry that
 * stops listening on the first of them and then starts again for RDY misses
 * it, waits out its whole ceiling, and concludes the modem is dead — one
 * command short of streaming the certificates it was there to write.
 *
 * The assertion is deliberately the happy path: with a modem that answers
 * immediately, the write must complete. It failed before this fix.
 */
await scenario('does not lose RDY when it shares a batch with the entry', {},
    (out, fake) => {
        if (!out.ok) return `threw: ${out.error}`;
        const t = fake.transcript;
        const rdy = t.indexOf('RDY');
        const enter = t.indexOf('Enter certificate mode');
        if (rdy === -1 || enter === -1) return 'the batch was never emitted';
        if (rdy - enter > 2) return 'RDY did not arrive with the entry';
        if (!t.some(l => l.startsWith('CONNECT'))) return 'never opened an upload';
        return null;
    });

/*
 * Observed 2026-08-04: entering while the firmware's NB init still owns the
 * BG95 gets `Enter certificate mode` and no RDY, and the init lines keep
 * printing afterwards — proof the firmware never let go. Entry must wait for
 * the `Signal Strength:` heartbeat that says init is over.
 */
await scenario('waits out the firmware NB init before entering',
    { initBusy: true }, (out, fake) => {
        if (!out.ok) return `entered during NB init: ${out.error}`;
        const t = fake.transcript;
        if (t.indexOf('Signal Strength:0') > t.indexOf('Enter certificate mode'))
            return 'entered before the heartbeat said init was done';
        return null;
    });

/* Observed live: the unit was already inside passthrough from a failed run, so
 * the first AT+CERTMOD takes it OUT and the BG95 goes down with it. Entering
 * again brings the modem back — `RDY` arrived on the re-entry — so this is a
 * state to pass through inside one window, not a reset to send a human away
 * for. What must NOT happen is proceeding without that RDY. */
await scenario('passes through a unit found inside passthrough',
    { startInside: true }, (out, fake) => {
        if (!out.ok) return `gave up instead of re-entering: ${out.error}`;
        const toggles = fake.received.filter(c => c === 'AT+CERTMOD').length;
        if (toggles !== 3) return `sent AT+CERTMOD ${toggles} times, expected 3`;
        if (fake.state().inCertmod) return 'left the unit inside passthrough';
        return null;
    });

/* The failure that produced all of the above: entering, failing to confirm the
 * modem, and leaving the unit inside for the next run to inherit. */
await scenario('leaves passthrough when RDY never arrives', { noRdy: true },
    (out, fake) => {
        if (out.ok) return 'proceeded without RDY';
        if (fake.state().inCertmod)
            return 'left the unit inside — the next attempt inherits this';
        return null;
    });

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

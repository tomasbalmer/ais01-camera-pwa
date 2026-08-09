/*
 * Every command the firmware answers, and what we can honestly say about each.
 *
 * The list itself is not ours: `APP_AT_COMMANDS` in `console-line-law.js` is
 * the 58-entry table read off the app firmware at 0x0801b4d4, and it is the
 * authority. This file adds two things to it — an order that puts the ones a
 * bench session reaches for at the top, and a description where THIS REPO can
 * back one up.
 *
 * The descriptions are deliberately incomplete. A command with no line beside
 * it is a command whose behaviour is documented in `AIS01-CB-LTE` and not here;
 * inventing a plausible sentence for it would make the list feel authoritative
 * exactly where it is guessing, and this screen talks to hardware.
 *
 * Picking an entry only FILLS the field. Sending stays a separate press.
 */

import { APP_AT_COMMANDS } from './console-line-law.js';

/*
 * The ones with a value already in them are written as a template with a
 * sensible value, because a command with the value missing is a command the
 * technician has to remember the syntax of — which is the thing this list
 * exists to stop.
 */
const DESCRIBED = {
    'AT+CFG': ['AT+CFG', 'every setting, in one dump'],
    'AT+CERTMOD': ['AT+CERTMOD', 'toggle BG95 passthrough — no query form, it just flips'],
    'AT+CSQTIME': ['AT+CSQTIME=1', 'minutes hunting for a network before power-off'],
    'AT+TDC': ['AT+TDC=1200', 'seconds between duty cycles'],
    /* The three the network profiles turn, described from what `REGIONS` in
     * provision.js already asserts and no further. */
    'AT+APN': ['AT+APN=', 'access point name — NULL lets the SIM decide'],
    'AT+IOTMOD': ['AT+IOTMOD=0', 'radio technology the modem may use'],
    'AT+QCOPS': ['AT+QCOPS=NULL', 'operator lock — NULL lets a multi-IMSI SIM choose'],
    'AT+PRO': ['AT+PRO=3,5', 'protocol — 3,5 is MQTT/TLS'],
    'AT+SERVADDR': ['AT+SERVADDR=', 'broker host and port'],
    'AT+PUBTOPIC': ['AT+PUBTOPIC=', 'uplink topic'],
    'AT+SUBTOPIC': ['AT+SUBTOPIC=', 'downlink topic'],
    'AT+CLIENT': ['AT+CLIENT=', 'MQTT client id — the AWS IoT thing name'],
    'AT+TLSMOD': ['AT+TLSMOD=1,2', 'TLS mode'],
    'AT+MQOS': ['AT+MQOS=0', 'QoS 0 — law, MQOS>0 has no PUBACK here'],
    'AT+SNI': ['AT+SNI=0', 'law — SNI=1 breaks the MQTT CONNECT silently'],
    'AT+BKDNS': ['AT+BKDNS=', 'fallback IP for when DNS does not answer'],
    'AT+GETLOG': ['AT+GETLOG', 'the firmware\'s own log'],
    'ATZ': ['ATZ', 'restart the unit — the link drops and comes back'],
    'AT+FDR': ['AT+FDR', 'FACTORY RESET — undoes provisioning'],
    'AT+FDR1': ['AT+FDR1', 'factory reset, second form'],
};

/* Destructive enough that the list says so rather than just listing it. */
export const DANGEROUS = new Set(['AT+FDR', 'AT+FDR1']);

/*
 * What a bench session reaches for that takes no value: press it and the whole
 * command is there.
 *
 * `AT+TDC` and `AT+CSQTIME` used to be here as templates with one number in
 * them, and they moved to `PRESETS` below. A template is only half an answer
 * for a command whose entire difficulty is which value to put in it.
 */
const FIRST = ['AT+CFG', 'ATZ', 'AT+CERTMOD', 'AT+GETLOG'];

/*
 * ── Values, not templates ────────────────────────────────────────────────
 *
 * The list above answers "what is this command called". These answer "and what
 * do I put in it", which for the settings that matter is the harder half and
 * the one a technician was doing from memory — `AT+TDC=` takes SECONDS, so
 * four hours is 14400, and nobody should be doing that arithmetic beside an
 * open AT window.
 *
 * Grouped by the parameter they turn rather than by command, because that is
 * the question being asked: how often should it report, how long should it
 * hunt, which radio may it use.
 *
 * Every value here is one this repo can back. `AT+IOTMOD=1` is missing for
 * that reason and not by oversight — `REGIONS` in provision.js establishes 0
 * and 2 against real SIMs, and a third mode nobody here has documented would
 * be this file guessing in a list people trust because it is a list.
 */
const PRESETS = [
    /*
     * TDC is seconds. The 20-minute entry is called out because it is what ④
     * sends (`ENVIRONMENTS.tdc`), so the list shows the standard rather than
     * leaving somebody to work out which of nine values is the normal one.
     */
    ['Reporting interval · AT+TDC', [
        ['AT+TDC=300',   'every 5 minutes'],
        ['AT+TDC=900',   'every 15 minutes'],
        ['AT+TDC=1200',  'every 20 minutes — the standard, what this app sends'],
        ['AT+TDC=1800',  'every 30 minutes'],
        ['AT+TDC=3600',  'hourly'],
        ['AT+TDC=7200',  'every 2 hours'],
        ['AT+TDC=14400', 'every 4 hours'],
        ['AT+TDC=28800', 'every 8 hours'],
        ['AT+TDC=43200', 'every 12 hours'],
    ]],
    /*
     * CSQTIME is minutes, and it is the one setting whose two costs point in
     * opposite directions: it is how long the firmware hunts for a network
     * before powering the modem down, so it is both the unit's chance of
     * attaching in the field AND the wait before a bench gets the idle state a
     * certificate write needs. The hints say which end each value is at.
     */
    ['Network search · AT+CSQTIME', [
        ['AT+CSQTIME=1',  '1 minute — reaches idle soonest, best for a bench'],
        ['AT+CSQTIME=2',  '2 minutes'],
        ['AT+CSQTIME=5',  '5 minutes'],
        ['AT+CSQTIME=10', '10 minutes — best chance of attaching, longest wait'],
    ]],
    ['Radio technology · AT+IOTMOD', [
        ['AT+IOTMOD=0', 'eMTC (LTE-M) only'],
        ['AT+IOTMOD=2', 'eMTC and NB-IoT'],
    ]],
];

/*
 * Commands the app does NOT intercept, so they cross into the BG95. They only
 * answer once the modem is reachable, which on this firmware means inside
 * passthrough — hence the separate group rather than a footnote.
 */
const BG95 = [
    ['AT+QFLST="*"', 'what the modem has stored, and at what size'],
    ['ATI', 'modem identity — also the echo probe'],
    ['AT+CFUN=0', 'radio off, AT and filesystem alive — a cert write runs here'],
    ['AT+CFUN=4', 'transmit disabled — the weaker form, if CFUN=0 is refused'],
    ['AT+CFUN=1', 'radio back on'],
    ['AT+QFDEL=', 'delete one stored file'],
];

const entryFor = name => DESCRIBED[name] || [name, ''];

/*
 * Every preset, by its exact text, so a hint can be about the VALUE.
 *
 * `AT+IOTMOD=0` deserves "eMTC (LTE-M) only" and not "radio technology the
 * modem may use" — the second answers a question nobody asked while looking at
 * a specific value. The presets already hold those sentences; this is the same
 * table read the other way round, so the two cannot say different things about
 * the same string.
 */
const PRESET_HINT = Object.fromEntries(
    PRESETS.flatMap(([, entries]) => entries));

/*
 * The hint for a command that already carries its value, for a caller building
 * rows out of real settings rather than templates. Falls back to what can be
 * said about the command itself when the exact value is not one we describe —
 * `AT+SERVADDR=<this unit's broker>` has no preset and never will.
 */
export function describe(text) {
    const exact = PRESET_HINT[text];
    if (exact) return exact;
    const found = DESCRIBED[String(text).split('=')[0]];
    return found ? found[1] : '';
}

/*
 * The groups that do not depend on which unit is loaded, in the order they are
 * offered. `provision.js` puts this unit's own settings in front and the
 * country profiles in the middle — both need `REGIONS`, which lives there.
 *
 * Ordering rule: the closer a group is to "what am I doing right now", the
 * higher it sits. Verbs, then values to choose, then the whole table for the
 * command nobody anticipated.
 */
export function catalogueGroups() {
    const rest = APP_AT_COMMANDS
        .filter(name => !FIRST.includes(name))
        .sort()
        .map(entryFor);

    return {
        common: ['Common', FIRST.map(entryFor)],
        presets: PRESETS,
        bg95: ['BG95 · inside passthrough', BG95],
        all: [`All ${APP_AT_COMMANDS.length} app commands`, rest],
    };
}

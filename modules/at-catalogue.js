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
 * What a bench session actually reaches for, in the order it reaches for them.
 * Everything else is still one scroll away — this is ordering, not filtering.
 */
const FIRST = [
    'AT+CFG', 'ATZ', 'AT+CSQTIME', 'AT+TDC', 'AT+CERTMOD', 'AT+GETLOG',
];

/*
 * Commands the app does NOT intercept, so they cross into the BG95. They only
 * answer once the modem is reachable, which on this firmware means inside
 * passthrough — hence the separate group rather than a footnote.
 */
const BG95 = [
    ['AT+QFLST="*"', 'what the modem has stored, and at what size'],
    ['ATI', 'modem identity — also the echo probe'],
    ['AT+CFUN=1', 'radio back on after a certificate write'],
    ['AT+CFUN=0', 'radio off — what a certificate write runs under'],
    ['AT+QFDEL=', 'delete one stored file'],
];

const entryFor = name => DESCRIBED[name] || [name, ''];

/*
 * Three groups, and the third one is the whole table.
 *
 * A caller adds "this unit" in front when a folder is loaded; those come from
 * `desiredSettings`, so they carry real values rather than templates.
 */
export function catalogueGroups() {
    const rest = APP_AT_COMMANDS
        .filter(name => !FIRST.includes(name))
        .sort()
        .map(entryFor);

    return [
        ['Common', FIRST.map(entryFor)],
        ['BG95 · inside passthrough', BG95],
        [`All ${APP_AT_COMMANDS.length} app commands`, rest],
    ];
}

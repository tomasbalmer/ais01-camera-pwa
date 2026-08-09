/*
 * The commands worth offering, and only those.
 *
 * The free-text field is the escape hatch and stays exactly as it was: whatever
 * is typed is sent as typed. This list is the paved path — the handful of
 * commands a bench session actually reaches for, spelled correctly, so nobody
 * is recalling `AT+CSQTIME` from memory at the one moment an AT window is open.
 *
 * Two rules decide what is in here:
 *
 *   IT MUST BE PROVEN IN THIS REPO. Every command below is one this app already
 *   sends, or one named in `console-line-law.js`'s table of the 58 the firmware
 *   answers. Nothing is here because a datasheet suggested it.
 *
 *   NOTHING DESTRUCTIVE. `AT+FDR` is a factory reset and is deliberately
 *   absent: a list you scroll is the wrong place for a command that undoes a
 *   provisioning session. It is still one thing to type, which is the right
 *   amount of friction for it.
 *
 * Picking an entry only FILLS the field. Sending stays a separate, deliberate
 * press — the technician owns when a command goes out, which is the same
 * principle the four stage buttons follow.
 */

/*
 * `AT+CFG` returns the whole property dump in one command, which is why there
 * is no per-setting query form here. Reading is one entry, not twenty.
 */
export const AT_CATALOGUE = [
    ['Read', [
        ['AT+CFG', 'every setting, in one dump'],
        ['AT+GETLOG', 'the firmware\'s own log'],
    ]],

    /*
     * `ATZ` is answered by the app itself, so it restarts the STM32 — the same
     * thing the board button does. It had a dedicated button on the log strip;
     * it is here instead, because a restart is a command like any other and the
     * strip is for the log, not for the device. `sendManual` still routes it
     * through the reset path so the boot divider and the window guidance
     * survive the move.
     */
    ['Restart', [
        ['ATZ', 'restart the unit — the link drops and comes back'],
    ]],

    /*
     * The two that decide how long a bench session waits. `AT+CSQTIME` is the
     * search window — how long the firmware hunts for a network before powering
     * the modem down, and therefore how long until the idle state a certificate
     * write needs. It is the command that made the manual row exist.
     */
    ['Timing', [
        ['AT+CSQTIME=1', 'minutes spent hunting for a network before power-off'],
        ['AT+TDC=1200', 'seconds between duty cycles'],
    ]],

    /*
     * Passthrough. `AT+CERTMOD` is a TOGGLE with no query form — sending it
     * blind is how a unit ends up inside passthrough without anyone knowing,
     * which certmod.js spends real code recovering from. It is here because
     * diagnosing a failed write needs it, not because it is routine.
     *
     * The three below it only answer once the BG95 is reachable, which on this
     * firmware means inside passthrough.
     */
    ['BG95 · inside passthrough', [
        ['AT+CERTMOD', 'toggle passthrough — no query form, it just flips'],
        ['AT+QFLST="*"', 'what the modem has stored, and at what size'],
        ['ATI', 'modem identity — also the echo probe'],
        ['AT+CFUN=1', 'radio back on after a certificate write'],
    ]],
];

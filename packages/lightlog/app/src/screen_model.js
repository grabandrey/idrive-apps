'use strict';
/*
 * Light Logger: what the screen shows. Pure, tested on a desktop by tools/test_lightlog.js.
 *
 * Without MGU Store's renderer the screen is the head unit's own list: a status line, four buttons, then LINES rows
 * of text in one of three views (Show steps through them):
 *   'seat'  the lights that may be the seat logos now (journal.relevant()), each with why
 *   'log'   the newest events first, only the seat lights', the car's, the marks and the link's
 *   'all'   every light module now
 * (ui.js draws the same with the renderer.)
 */
const lin = require('./lin.js');
const { line } = require('./journal.js');

const LINES = 40;
const BUTTONS = [
    { id: 21, name: 'llMark', label: 'Mark this moment' },
    { id: 22, name: 'llRead', label: 'Read the lights now' },
    { id: 23, name: 'llView', label: 'Show' },
    { id: 24, name: 'llClear', label: 'Clear the log on screen' },
];
const LINE_IDS = Array.apply(null, Array(LINES)).map((_, i) => ({ id: 40 + i, name: 'llLine' + i }));

function status(s) {
    const parts = [];
    parts.push(s.linkReady ? 'diagnostic link ready' : 'diagnostic link: ' + (s.linkError || 'starting'));
    s.buses.forEach((b, i) => {
        const name = lin.BUSES[i].name;
        if (b.refused) parts.push(name + ': refused (' + b.refused + ')');
        else if (b.modules === null) parts.push(name + ': ' + (b.reads ? 'no answer yet' : 'waiting'));
        else parts.push(name + ': ' + b.modules + ' modules, ' + b.on + ' on');
    });
    parts.push(s.engine === true ? 'engine running' : s.engine === false ? 'engine off' : 'engine ?');
    if (s.kmh !== null && s.kmh !== undefined) parts.push(Math.round(s.kmh) + ' km/h');
    parts.push(s.file ? 'file ' + s.file : 'no log file');
    return parts.join('  |  ');
}

const VIEWS = ['seat', 'log', 'all'];
const VIEW_LABELS = { seat: 'Seat lights now', log: 'Seat light log', all: 'All lights now' };
const REASONS = { pinned: 'PINNED', seat: 'SEAT', mark: 'CHANGED AT MARK', unknown: 'UNKNOWN CODE' };

function viewLabel(view) { return VIEW_LABELS[view] || VIEW_LABELS.seat; }
function nextView(view) { return VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]; }
function tags(m) { return (m.reasons || []).map((r) => REASONS[r]).join(', '); }

/* what the seat view says when no light qualifies */
function noSeatText(journal) {
    const all = journal.modules();
    if (!all.length) return ['No answer from the body controller yet.'];
    return [
        'No seat light so far.',
        'The body controller has ' + all.length + ' light modules: none in a seat, none with an unknown code.',
        'Press Mark this moment when the logos go dark: any light that changes then shows up here.',
        'If none does, the logos are not on these light buses (see All for every light).',
    ];
}

/* the LINES rows' texts */
function lines(view, journal) {
    let out;
    if (view === 'all') {
        out = journal.modules().map((m) => lin.describe(m) + '  [' + m.raw + ']');
        if (!out.length) out = ['No answer from the body controller yet.'];
    } else if (view === 'log') {
        out = journal.events.filter((e) => journal.isRelevant(e)).reverse().map((e) => (e.seat ? '>> ' : '') + line(e));
        if (!out.length) out = ['Nothing logged yet.'];
    } else {
        out = journal.relevant().map((m) => '[' + tags(m) + '] ' + lin.describe(m) + '  [' + m.raw + ']');
        if (!out.length) out = noSeatText(journal);
    }
    while (out.length < LINES) out.push('');
    return out.slice(0, LINES);
}

/* what ui.js draws: the left card is the seat lights, or all of them ('all'); the right one the seat light log */
function drawModel(journal, st, view, focus, pressed) {
    return {
        status: st, view: view === 'all' ? 'all' : 'seat', seat: journal.relevant(), all: journal.modules(),
        noSeat: noSeatText(journal), log: journal.events.filter((e) => journal.isRelevant(e)).reverse().slice(0, 20),
        pins: Array.from(journal.pins), marks: journal.marks, focus: focus, pressed: pressed,
    };
}

module.exports = { drawModel, LINES, BUTTONS, LINE_IDS, VIEWS, REASONS, status, lines, viewLabel, nextView, tags, noSeatText };

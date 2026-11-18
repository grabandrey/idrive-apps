'use strict';
/*
 * Light Logger: what the screen shows. Pure, tested on a desktop by tools/test_lightlog.js.
 *
 * The screen is the head unit's own list: a status line, four buttons, then LINES rows of text, either the newest
 * events first ('events') or every light module now, the seat ones first ('lights').
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

function viewLabel(view) { return view === 'lights' ? 'Light modules now' : 'Events, newest first'; }
function nextView(view) { return view === 'lights' ? 'events' : 'lights'; }

/* the LINES rows' texts */
function lines(view, journal) {
    let out;
    if (view === 'lights') {
        const mods = journal.modules().slice().sort((a, b) => (b.seat - a.seat) || (a.bus - b.bus) || (a.nad - b.nad));
        out = mods.map((m) => (m.seat ? '[SEAT] ' : '') + lin.describe(m) + '  [' + m.raw + ']');
        if (!out.length) out = ['No answer from the body controller yet.'];
    } else {
        out = journal.events.slice().reverse().map((e) => (e.seat ? '>> ' : '') + line(e));
        if (!out.length) out = ['Nothing logged yet.'];
    }
    while (out.length < LINES) out.push('');
    return out.slice(0, LINES);
}

module.exports = { LINES, BUTTONS, LINE_IDS, status, lines, viewLabel, nextView };

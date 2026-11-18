/*
 * Vitals: the widget's geometry, in layer pixels (632 x 572, the iDrive 8 widget's safe rect).
 * One place for it: shader.js draws the graphics from it, view.js places the text with it.
 * Works in Node (module.exports) and in a browser (window.VITALS_LAYOUT).
 */
(function (root) {
    var L = {
        W: 632, H: 572,
        /* temperature arcs: 240 degrees, open at the bottom, clockwise from lower left */
        arc: { r: 104, width: 9, a0: 150, sweep: 240, min: 50, max: 150 },
        gauges: [
            { key: 'coolant', label: 'COOLANT', cx: 166, cy: 150 },
            { key: 'oil', label: 'OIL', cx: 466, cy: 150 },
        ],
        divider: { y: 284, x0: 40, x1: 592 },
        tyreHead: { y: 316 },
        car: { cx: 316, cy: 448, hw: 52, hh: 98, r: 34 },
        tyre: { dx: 66, yFront: 394, yRear: 502, hw: 12, hh: 26, r: 6 },
        tyreText: { left: 226, right: 406 },
    };
    L.corners = [
        { key: 'FL', x: L.car.cx - L.tyre.dx, y: L.tyre.yFront, side: 'left' },
        { key: 'FR', x: L.car.cx + L.tyre.dx, y: L.tyre.yFront, side: 'right' },
        { key: 'RL', x: L.car.cx - L.tyre.dx, y: L.tyre.yRear, side: 'left' },
        { key: 'RR', x: L.car.cx + L.tyre.dx, y: L.tyre.yRear, side: 'right' },
    ];
    if (typeof module !== 'undefined' && module.exports) module.exports = L;
    else root.VITALS_LAYOUT = L;
})(this);

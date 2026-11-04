// Dynamic motion augmentation figure: one frame of the augmented reference at
// the selected ramp inclination and box mass, rendered in MuJoCo with the
// nominal reference as a blue ghost, under an SVG overlay of the torso pitch
// and the foot placement dead zone. The images and the overlay coordinates
// (in image pixels) are rendered offline from the augmented motion dataset.
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.aug-card-toggle').forEach(function (button) {
    button.addEventListener('click', function () {
      var more = button.closest('.aug-card').querySelector('.aug-card-more');
      more.hidden = !more.hidden;
      button.setAttribute('aria-expanded', String(!more.hidden));
      button.querySelector('span').textContent = more.hidden ? 'Show more' : 'Show less';
    });
  });

  var svg = document.getElementById('aug-svg');
  var slopeIn = document.getElementById('aug-slope');
  var massIn = document.getElementById('aug-mass');
  if (!svg || !slopeIn || !massIn) {
    return;
  }

  var DIR = './static/images/aug/';
  var NS = 'http://www.w3.org/2000/svg';
  var COLORS = {
    nominal: '#3d8bfd',
    augmented: '#363636',
    accent: '#e8663d',
    zone: '#6b7785'
  };
  var ARROW = 22;
  var overlay = null, image = null, layer = null, wanted = null;
  var cache = {};

  // Decode a picture before it is shown. Only its address is kept afterwards, so the browser
  // is free to drop decoded pictures that are no longer on show.
  function load(key) {
    if (!cache[key]) {
      var img = new Image();
      var src = DIR + key + '.webp';
      img.src = src;
      cache[key] = img.decode().then(function () { return src; }, function () { return src; });
    }
    return cache[key];
  }

  function el(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) {
      e.setAttribute(k, attrs[k]);
    }
    parent.appendChild(e);
    return e;
  }

  function text(parent, x, y, str, attrs) {
    var t = el('text', Object.assign({x: x, y: y, class: 'aug-label'}, attrs || {}), parent);
    t.textContent = str;
    return t;
  }

  function line(parent, a, b, attrs) {
    return el('line', Object.assign({x1: a[0], y1: a[1], x2: b[0], y2: b[1]}, attrs), parent);
  }

  function along(p, v, len) {
    return [p[0] + v[0] * len, p[1] + v[1] * len];
  }

  // Clockwise angle of an image direction from straight up, in radians.
  function tilt(v) {
    return Math.atan2(v[0], -v[1]);
  }

  function draw(c) {
    var px = overlay.pxPerMeter;

    // Dead zone around the nominal rear footprint, labeled under the ramp surface.
    var z = c.zone;
    el('polygon', {points: z.map(function (p) { return p.join(','); }).join(' '),
                   fill: COLORS.zone, 'fill-opacity': 0.16}, layer);
    var dash = {stroke: COLORS.zone, 'stroke-width': 3, 'stroke-dasharray': '10 8'};
    line(layer, z[0], z[3], dash);
    line(layer, z[1], z[2], dash);
    var down = [z[0][0] - z[3][0], z[0][1] - z[3][1]];
    var n = Math.hypot(down[0], down[1]);
    var mid = [(z[0][0] + z[1][0]) / 2, (z[0][1] + z[1][1]) / 2];
    var lp = along(mid, [down[0] / n, down[1] / n], 0.2 * px);
    text(layer, lp[0], lp[1], 'Dead zone', {'text-anchor': 'middle', 'dominant-baseline': 'middle'});

    // Rear foot shift from the nominal footprint.
    var a = c.footNominal, b = c.footAugmented;
    var shift = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (shift > 10) {
      var foot = {stroke: COLORS.accent, 'stroke-width': 6};
      if (shift > ARROW + 8) {
        b = along(b, [(a[0] - b[0]) / shift, (a[1] - b[1]) / shift], ARROW - 2);
        foot['marker-end'] = 'url(#aug-ah)';
      }
      line(layer, a, b, foot);
    }

    // Torso axes from the augmented torso, with the pitch between them.
    var t = c.torso, len = 0.75 * px, r = 0.64 * px;
    line(layer, t, along(t, c.axisNominal, len),
         {stroke: COLORS.nominal, 'stroke-width': 5, 'stroke-dasharray': '16 10'});
    line(layer, t, along(t, c.axisAugmented, len),
         {stroke: COLORS.augmented, 'stroke-width': 5, 'stroke-dasharray': '16 10'});
    // The arc stops short of the augmented axis so that the arrow tip only
    // touches it, and drops the arrowhead when there is no room for one.
    // Arrowheads start where their line ends, so the line never shows past
    // the tip.
    var t0 = tilt(c.axisNominal), t1 = tilt(c.axisAugmented);
    var sweep = Math.abs(t1 - t0) * r;
    if (sweep > 12) {
      var dir = t1 > t0 ? 1 : -1;
      var head = sweep > ARROW + 12;
      var te = t1 - dir * (head ? ARROW + 2 : 0) / r;
      var p0 = along(t, c.axisNominal, r), p1 = [t[0] + r * Math.sin(te), t[1] - r * Math.cos(te)];
      var arc = {d: 'M' + p0.join(',') + ' A' + r + ',' + r + ' 0 0 ' + (dir > 0 ? 1 : 0) + ' ' + p1.join(','),
                 fill: 'none', stroke: COLORS.accent, 'stroke-width': 6};
      if (head) {
        arc['marker-end'] = 'url(#aug-ah)';
      }
      el('path', arc, layer);
    }
    var tp = along(t, t0 < t1 ? c.axisNominal : c.axisAugmented, len);
    text(layer, tp[0] - 14, tp[1] + 10, 'Torso pitch', {'text-anchor': 'end'});
  }

  function render() {
    var slope = Number(slopeIn.value), mass = Number(massIn.value);
    document.getElementById('aug-slope-value').textContent = slope + '°';
    document.getElementById('aug-mass-value').textContent = mass + ' kg';
    if (!overlay) {
      return;
    }
    // Swap the picture and its overlay together, once the picture is decoded,
    // so that the two never disagree while sliding.
    var key = 'm' + mass + '_s' + slope;
    wanted = key;
    load(key).then(function (src) {
      if (wanted !== key) {
        return;
      }
      image.setAttribute('href', src);
      layer.replaceChildren();
      draw(overlay.conditions[key]);
    });
  }

  // Nothing is fetched until the figure comes near the viewport. Then every picture is
  // downloaded into the HTTP cache, and only the one on show is decoded, which keeps the
  // memory of the page low while sliding stays instant.
  function start() {
    fetch(DIR + 'overlay.json').then(function (r) { return r.json(); }).then(function (data) {
      overlay = data;
      svg.setAttribute('viewBox', '0 0 ' + data.size[0] + ' ' + data.size[1]);
      var defs = el('defs', {}, svg);
      var m = el('marker', {id: 'aug-ah', viewBox: '0 0 10 10', refX: 1, refY: 5, markerWidth: ARROW,
                            markerHeight: ARROW, markerUnits: 'userSpaceOnUse', orient: 'auto'}, defs);
      el('path', {d: 'M0,0 L10,5 L0,10 z', fill: COLORS.accent}, m);
      image = el('image', {x: 0, y: 0, width: data.size[0], height: data.size[1]}, svg);
      layer = el('g', {}, svg);
      render();
      update();
      data.masses.forEach(function (mm) {
        data.slopes.forEach(function (ss) {
          fetch(DIR + 'm' + mm + '_s' + ss + '.webp', {priority: 'low'});
        });
      });
    });
  }

  var io = new IntersectionObserver(function (entries) {
    if (entries[0].isIntersecting) {
      io.disconnect();
      start();
    }
  }, {rootMargin: '600px'});
  io.observe(svg);

  // Until the reader touches a slider, the figure plays itself along the diagonal from the
  // lightest box on level ground to the heaviest on the steepest ramp and back, with the
  // sliders following, so that the posture change shows even to readers who only scroll.
  // The first touch hands control over for good. It pauses while the figure is out of view
  // and does not run at all for readers who ask for reduced motion.
  var hint = document.getElementById('aug-hint');
  var STEP_MS = 1200, HOLD_STEPS = 1;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var touched = false, inView = false, timer = null;
  var path = [], at = 0;

  function buildPath() {
    var n = Math.min(overlay.masses.length, overlay.slopes.length);
    var up = [];
    for (var i = 0; i < n; i++) {
      up.push([overlay.masses[i], overlay.slopes[i]]);
    }
    // Hold a little at both ends, then come back.
    var ends = function (p) { var r = []; for (var h = 0; h < HOLD_STEPS; h++) r.push(p); return r; };
    path = up.concat(ends(up[n - 1]), up.slice(1, n - 1).reverse(), ends(up[0]));
    // Start next to the current setting, so the first step is a small one.
    var m0 = Number(massIn.value), s0 = Number(slopeIn.value), best = Infinity;
    for (var k = 0; k < n; k++) {
      var d = Math.abs(path[k][0] - m0) / 10 + Math.abs(path[k][1] - s0) / 15;
      if (d < best) {
        best = d;
        at = k;
      }
    }
  }

  function tick() {
    if (!overlay) {
      return;
    }
    if (!path.length) {
      buildPath();
    }
    at = (at + 1) % path.length;
    massIn.value = path[at][0];
    slopeIn.value = path[at][1];
    render();
  }

  function update() {
    var play = overlay && inView && !touched && !reduced;
    if (play && !timer) {
      timer = setInterval(tick, STEP_MS);
    } else if (!play && timer) {
      clearInterval(timer);
      timer = null;
    }
    hint.hidden = touched || !overlay;
    hint.textContent = reduced ? 'Drag a slider to explore' : 'Auto-playing \u00b7 drag a slider to take over';
  }

  function takeOver() {
    touched = true;
    update();
  }
  [slopeIn, massIn].forEach(function (input) {
    input.addEventListener('pointerdown', takeOver);
    input.addEventListener('keydown', takeOver);
    input.addEventListener('input', function (e) {
      if (e.isTrusted) {
        takeOver();
      }
      render();
    });
  });

  new IntersectionObserver(function (entries) {
    inView = entries[0].isIntersecting;
    update();
  }, {threshold: 0.5}).observe(svg);

  render();
});

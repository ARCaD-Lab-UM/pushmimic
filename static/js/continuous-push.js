// Continuous push clips play at double speed, and at their original speed while the mouse is over them.
// A bar along the bottom of each clip shows the box mass and the ramp angle on the left, and the playback
// speed and the time since the recording started on the right. The time runs at the speed of the experiment.
// Whichever of mass and angle changes during the clip is highlighted, with a track that fills over its range.
(() => {
  const fast = 2;
  const NS = 'http://www.w3.org/2000/svg';
  // Every triangle is 12 units tall, so the fast forward triangles match the play triangle.
  const shapes = {
    fast: { box: '0 0 20 16', points: ['1,2 10,8 1,14', '10,2 19,8 10,14'] },
    original: { box: '0 0 16 16', points: ['4,2 14,8 4,14'] },
  };

  // Box mass holds each value until the next change. Ramp angle runs linearly between inclinometer readings.
  const quantities = [
    { key: 'mass', label: 'Box', step: true, format: (value) => `${Math.round(value)} kg` },
    { key: 'ramp', label: 'Ramp', step: false, format: (value) => `${value.toFixed(1)}°` },
  ];

  function icon(name) {
    const { box, points } = shapes[name];
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', box);
    svg.classList.add(`icon-${name}`);
    for (const p of points) {
      const polygon = document.createElementNS(NS, 'polygon');
      polygon.setAttribute('points', p);
      svg.append(polygon);
    }
    return svg;
  }

  // A list of "time value" pairs, or a single value for a quantity that stays the same.
  function parse(text) {
    return text.split(',').map((part) => {
      const numbers = part.trim().split(/\s+/).map(Number);
      return numbers.length === 1 ? [0, numbers[0]] : numbers;
    });
  }

  function valueAt(points, time, step) {
    let i = 0;
    while (i + 1 < points.length && points[i + 1][0] <= time) i += 1;
    if (step || i + 1 === points.length) return points[i][1];
    const [t0, v0] = points[i];
    const [t1, v1] = points[i + 1];
    return v0 + ((v1 - v0) * (time - t0)) / (t1 - t0);
  }

  function clock(time) {
    const seconds = Math.floor(time);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function element(tag, className, parent) {
    const node = document.createElement(tag);
    node.className = className;
    parent.append(node);
    return node;
  }

  function field(label, parent) {
    const root = element('div', 'hud-field', parent);
    element('span', 'hud-label', root).textContent = label;
    const value = element('span', 'hud-value', root);
    const fill = element('i', '', element('span', 'hud-track', root));
    return { root, value, fill };
  }

  for (const player of document.querySelectorAll('.push-player')) {
    const video = player.querySelector('video');
    const hud = element('div', 'hud', player);
    hud.setAttribute('aria-hidden', 'true');
    const conditions = element('div', 'hud-group', hud);
    const playback = element('div', 'hud-group', hud);

    const readouts = quantities
      .filter((quantity) => player.dataset[quantity.key])
      .map((quantity) => {
        const points = parse(player.dataset[quantity.key]);
        const values = points.map((point) => point[1]);
        const readout = { ...quantity, points, min: Math.min(...values), max: Math.max(...values) };
        Object.assign(readout, field(quantity.label, conditions));
        readout.varying = readout.max > readout.min;
        readout.root.classList.toggle('is-varying', readout.varying);
        return readout;
      });

    const speed = field('Speed', playback);
    const time = field('Time', playback);
    const icons = { fast: icon('fast'), original: icon('original') };

    function setRate(rate) {
      // A reload falls back to the default rate, so both are set.
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
      speed.value.replaceChildren(rate === 1 ? icons.original : icons.fast, `${rate}×`);
    }

    function update() {
      const now = video.currentTime || 0;
      time.value.textContent = clock(now);
      for (const readout of readouts) {
        const value = valueAt(readout.points, now, readout.step);
        readout.value.textContent = readout.format(value);
        if (readout.varying) {
          readout.fill.style.width = `${(100 * (value - readout.min)) / (readout.max - readout.min)}%`;
        }
      }
    }

    setRate(fast);
    player.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') setRate(1);
    });
    player.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse') setRate(fast);
    });

    // Per frame where the browser supports it, otherwise on the regular time updates.
    if ('requestVideoFrameCallback' in video) {
      const onFrame = () => {
        update();
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    } else {
      video.addEventListener('timeupdate', update);
    }
    video.addEventListener('seeked', update);
    update();
  }
})();

(() => {
  const comparison = document.getElementById('ramp-comparison');
  const angles = Array.from(comparison.querySelectorAll('[data-angle]'));
  const stages = Array.from(comparison.querySelectorAll('.ramp-stage'));
  const status = comparison.querySelector('.ramp-compare-status');
  const duration = 7.5; // Every single push clip lasts 7.5 s.
  const source = new URL('./static/videos/single-push/', document.baseURI);
  const pairs = new Map();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Similarity transforms fitted to the fixed background of each camera's 0° clip.
  // Entries are horizontal and vertical shifts (% of frame), roll (degrees), and scale.
  const alignment = {
    0: [[0, 0, 0, 1], [0, 0, 0, 1]],
    5: [[-0.171, 0.242, -0.237, 1.00066], [-0.019, 0, -0.014, 0.99954]],
    10: [[-0.032, 0.109, -0.294, 0.99880], [-0.033, -0.023, 0.003, 0.99908]],
    12: [[-0.131, 0.122, -0.228, 0.99887], [-0.023, -0.003, -0.015, 0.99917]],
  };
  const crop = [1.02, 1.01];

  let activeAngle = '0';
  let requestedAngle = activeAngle;
  let incoming = [];
  let switching = false;
  let preloaded = false;
  // Until a visitor picks an angle, the angle steps on during the push, holding each for a moment.
  const hold = 1000;
  let touched = false;
  let timer = null;
  let step = 1; // Rises to the steepest angle, then comes back down one angle at a time.

  for (const button of angles) {
    const angle = button.dataset.angle;
    const pair = stages.map((stage, i) => {
      const clip = document.createElement('video');
      const name = `${angle}deg-cam${i + 1}`;
      const [x, y, roll, scale] = alignment[angle][i];
      clip.muted = true;
      clip.loop = true;
      clip.playsInline = true;
      clip.preload = angle === activeAngle ? 'auto' : 'metadata';
      clip.poster = new URL(`${name}.jpg`, source).href;
      clip.src = new URL(`${name}.mp4`, source).href;
      clip.style.transform = `scale(${crop[i]}) translate(${x}%, ${y}%) rotate(${roll}deg) scale(${scale})`;
      clip.setAttribute('aria-hidden', 'true');
      clip.classList.toggle('is-active', angle === activeAngle);
      stage.append(clip);
      return clip;
    });
    pair[0].addEventListener('timeupdate', () => {
      if (activeAngle !== angle || pair[0].paused) return;
      const time = pair[0].currentTime;
      for (const clip of [pair[1], ...incoming]) keepInStep(clip, time);
    });
    pairs.set(angle, pair);
    button.addEventListener('click', () => {
      touched = true;
      window.clearTimeout(timer);
      select(angle);
    });
  }

  function showPressed(angle) {
    for (const button of angles) button.setAttribute('aria-pressed', String(button.dataset.angle === angle));
  }

  // The button follows the request at once. The clips follow once the new pair is ready.
  function select(angle) {
    requestedAngle = angle;
    showPressed(angle);
    if (!switching) switchAngle();
  }

  function scheduleAdvance(visible) {
    window.clearTimeout(timer);
    if (visible && !touched && !reducedMotion.matches) timer = window.setTimeout(advance, hold);
  }

  function advance() {
    if (touched || switching) return;
    const current = angles.findIndex((button) => button.dataset.angle === activeAngle);
    if (!angles[current + step]) step = -step;
    select(angles[current + step].dataset.angle);
  }

  function phaseDistance(from, to) {
    const difference = Math.abs(from - to);
    return Math.min(difference, duration - difference);
  }

  function keepInStep(clip, time) {
    if (!clip.seeking && phaseDistance(clip.currentTime, time) > 0.06) clip.currentTime = time;
  }

  function updatePlayback() {
    const pair = pairs.get(activeAngle);
    const clips = [...pair, ...incoming];
    const bounds = comparison.getBoundingClientRect();
    const visible = bounds.bottom > 0 && bounds.top < window.innerHeight;
    if (visible && !preloaded) {
      preloaded = true;
      for (const pair of pairs.values()) {
        for (const clip of pair) clip.preload = 'auto';
      }
    }
    scheduleAdvance(visible);
    if (!visible) {
      clips.forEach((clip) => clip.pause());
      return;
    }
    const time = pair[0].currentTime;
    for (const clip of clips) {
      if (time >= duration) clip.currentTime = 0;
      else keepInStep(clip, time);
    }
    for (const clip of clips) clip.play().catch(() => {});
  }

  function seekFrame(clip, seconds) {
    clip.preload = 'auto';
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(failed, 5000);

      function done(error) {
        window.clearTimeout(timeout);
        clip.removeEventListener('loadeddata', ready);
        clip.removeEventListener('seeked', ready);
        clip.removeEventListener('error', failed);
        if (error) reject(error);
        else resolve();
      }

      function ready() {
        if (clip.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !clip.seeking &&
            Math.abs(clip.currentTime - seconds) < 0.04) done();
      }

      function failed() {
        done(new Error('The comparison frame could not load.'));
      }

      clip.addEventListener('loadeddata', ready);
      clip.addEventListener('seeked', ready);
      clip.addEventListener('error', failed);
      if (clip.currentTime !== seconds) clip.currentTime = seconds;
      if (clip.error) failed();
      else ready();
    });
  }

  async function crossfade(previous, next) {
    const fades = [];
    if (!reducedMotion.matches) {
      for (const clip of next) {
        clip.classList.add('is-incoming');
        fades.push(clip.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 320, easing: 'ease-in-out', fill: 'forwards',
        }));
      }
      await Promise.all(fades.map((fade) => fade.finished));
    }
    for (const clip of previous) clip.classList.remove('is-active');
    for (const clip of next) {
      clip.classList.add('is-active');
      clip.classList.remove('is-incoming');
    }
    for (const fade of fades) fade.cancel();
  }

  async function switchAngle() {
    const angle = requestedAngle;
    if (angle === activeAngle) return;
    switching = true;
    const previous = pairs.get(activeAngle);
    const next = pairs.get(angle);
    const lead = previous[0];
    status.textContent = '';
    try {
      // Keep the outgoing clips playing while the hidden pair prepares its frames.
      const time = lead.currentTime;
      await Promise.all(next.map((clip) => seekFrame(clip, time)));
      if (angle !== requestedAngle) return;
      const liveTime = lead.currentTime;
      if (phaseDistance(liveTime, time) > 1 / 30) {
        await Promise.all(next.map((clip) => seekFrame(clip, liveTime)));
      }
      if (angle !== requestedAngle) return;

      incoming = next;
      if (!lead.paused) {
        for (const clip of incoming) clip.play().catch(() => {});
      }
      await crossfade(previous, next);
      previous.forEach((clip) => clip.pause());
      activeAngle = angle;
    } catch {
      if (angle === requestedAngle) {
        requestedAngle = activeAngle;
        showPressed(activeAngle);
        status.textContent = `The ${angle}° clips could not load. Select the angle to try again.`;
      }
    } finally {
      if (activeAngle !== angle) next.forEach((clip) => clip.pause());
      incoming = [];
      switching = false;
      if (requestedAngle !== activeAngle) switchAngle();
      else updatePlayback();
    }
  }

  comparison.hidden = false;

  new IntersectionObserver(updatePlayback).observe(comparison);
  updatePlayback();
})();

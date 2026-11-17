(() => {
  const gallery = document.querySelector('.single-push-scroll');
  const clips = Array.from(gallery.querySelectorAll('video'));
  const [lead, ...followers] = clips;
  let playbackRequest = 0;

  clips.forEach((clip) => { clip.controls = false; });

  lead.addEventListener('timeupdate', () => {
    if (lead.paused || lead.controls) return;
    for (const clip of followers) {
      if (Math.abs(clip.currentTime - lead.currentTime) > 0.08) {
        clip.currentTime = lead.currentTime;
      }
    }
  });

  new IntersectionObserver(async ([entry]) => {
    const request = ++playbackRequest;
    if (!entry.isIntersecting) {
      clips.forEach((clip) => clip.pause());
      return;
    }

    const start = lead.currentTime;
    try {
      await Promise.all(clips.map((clip) => clip.play()));
      if (request !== playbackRequest) return;
      // Use the same start after all views have buffered enough to play.
      for (const clip of clips) {
        clip.controls = false;
        clip.currentTime = start;
      }
    } catch {
      if (request !== playbackRequest) return;
      for (const clip of clips) {
        clip.pause();
        clip.controls = true;
      }
    }
  }).observe(gallery);
})();

// The two torso pitch clips are equally long and play as one: they start, pause and loop together,
// and the second one jumps to the first one's time whenever they drift apart.
(() => {
  const [lead, follow] = document.querySelectorAll('#torso-pitch video');
  if (!lead || !follow) return;
  const tolerance = 0.1;

  function align() {
    if (Math.abs(follow.currentTime - lead.currentTime) > tolerance) follow.currentTime = lead.currentTime;
  }

  lead.addEventListener('play', () => {
    align();
    follow.play().catch(() => {});
  });
  lead.addEventListener('pause', () => follow.pause());
  lead.addEventListener('seeked', align);
  lead.addEventListener('timeupdate', align);
})();

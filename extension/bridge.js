// Isolated-world relay: page script -> extension background (toolbar badge).
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (ev.source !== window || !d || d.__t3x !== true || d.type !== 'count') return;
  try {
    chrome.runtime.sendMessage({ type: 't3x-count', count: d.count | 0, three: !!d.three });
  } catch (e) { /* extension reloaded; ignore */ }
});

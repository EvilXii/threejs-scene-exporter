// Shows the number of detected 3D scenes on the toolbar icon.
const perTab = new Map(); // tabId -> Map(frameId -> {count, three})

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 't3x-count' || !sender.tab) return;
  const tabId = sender.tab.id;
  let frames = perTab.get(tabId);
  if (!frames) { frames = new Map(); perTab.set(tabId, frames); }
  frames.set(sender.frameId || 0, { count: msg.count, three: msg.three });
  let total = 0, three = false;
  for (const v of frames.values()) { total += v.count; three = three || v.three; }
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f5bea' });
  chrome.action.setBadgeText({ tabId, text: total ? String(total) : three ? '3D' : '' });
});

chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') perTab.delete(tabId); });
chrome.tabs.onRemoved.addListener((tabId) => perTab.delete(tabId));

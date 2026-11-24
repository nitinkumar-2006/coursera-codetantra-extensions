let labCloseArmedUntil = 0;
let labCloseDelayMs = 7000;
let sourceTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "ARM_LAB_TAB_CLOSE") {
    labCloseArmedUntil = Date.now() + 12000;
    labCloseDelayMs = msg.delayMs || 7000;
    sourceTabId = sender?.tab?.id || null;
    sendResponse({ ok: true });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (Date.now() > labCloseArmedUntil) return;
  if (!tab || !tab.id || tab.id === sourceTabId) return;

  // Disarm immediately so only the single launched lab tab is auto-closed
  labCloseArmedUntil = 0;
  const tabIdToClose = tab.id;
  const returnTabId = sourceTabId;

  setTimeout(() => {
    chrome.tabs.remove(tabIdToClose, () => {
      // Ignore error if user already closed the tab manually
      void chrome.runtime.lastError;
      if (returnTabId) {
        chrome.tabs.update(returnTabId, { active: true }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
  }, labCloseDelayMs);
});

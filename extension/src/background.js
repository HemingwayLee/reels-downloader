// Clicking the toolbar icon opens the side panel next to the current tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

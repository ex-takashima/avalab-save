// Content script (ISOLATED world) - bridges page and background

// Method 1: Receive token from inject.js via postMessage
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === 'AVALAB_EXT_AUTH') {
    chrome.runtime.sendMessage({
      type: 'SET_TOKEN',
      token: event.data.token
    });
  }
});

// Method 2: Read Firebase token from IndexedDB directly
async function getFirebaseToken() {
  try {
    const dbs = await indexedDB.databases();
    // Find Firebase-related databases
    for (const dbInfo of dbs) {
      if (!dbInfo.name) continue;
      if (dbInfo.name.includes('firebase') || dbInfo.name.includes('firebaseLocalStorage')) {
        const token = await readFirebaseDB(dbInfo.name);
        if (token) return token;
      }
    }
    return null;
  } catch (e) {
    console.log('[avalab-save] IndexedDB scan error:', e);
    return null;
  }
}

function readFirebaseDB(dbName) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbName);
      req.onerror = () => resolve(null);
      req.onsuccess = (event) => {
        const db = event.target.result;
        const storeNames = [...db.objectStoreNames];
        for (const storeName of storeNames) {
          try {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const getAll = store.getAll();
            getAll.onsuccess = () => {
              for (const val of getAll.result) {
                // Firebase auth user objects contain stsTokenManager
                const token = extractToken(val);
                if (token) {
                  chrome.runtime.sendMessage({
                    type: 'SET_TOKEN',
                    token: 'Bearer ' + token
                  });
                  resolve(token);
                  return;
                }
              }
              resolve(null);
            };
            getAll.onerror = () => resolve(null);
          } catch (e) {
            continue;
          }
        }
        if (storeNames.length === 0) resolve(null);
      };
    } catch (e) {
      resolve(null);
    }
  });
}

function extractToken(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // Direct token manager
  if (obj.stsTokenManager && obj.stsTokenManager.accessToken) {
    return obj.stsTokenManager.accessToken;
  }

  // Nested in value property (Firebase format)
  if (obj.value && typeof obj.value === 'object') {
    return extractToken(obj.value);
  }
  if (obj.value && typeof obj.value === 'string') {
    try {
      return extractToken(JSON.parse(obj.value));
    } catch (e) {
      // not JSON
    }
  }

  // Search nested objects
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      const found = extractToken(obj[key]);
      if (found) return found;
    }
  }

  return null;
}

// Run Firebase token extraction after page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(getFirebaseToken, 1000);
  });
} else {
  setTimeout(getFirebaseToken, 1000);
}

// Also respond to manual token request from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'REQUEST_TOKEN') {
    getFirebaseToken().then((token) => {
      sendResponse({ token: token ? 'Bearer ' + token : null });
    });
    return true;
  }
});

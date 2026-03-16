// Background service worker
// Stores captured auth token and handles API requests

let authToken = null;

// Open tab on icon click (instead of popup)
chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL('popup.html');
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
});

// Receive token from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SET_TOKEN') {
    authToken = msg.token;
    console.log('[avalab-save] Token captured');
    return;
  }

  if (msg.type === 'CHECK_LOGIN') {
    sendResponse({ loggedIn: !!authToken });
    return false;
  }

  if (msg.type === 'FETCH_IMAGES') {
    fetchAllImages(msg.maxCount).then(sendResponse);
    return true;
  }

  if (msg.type === 'FETCH_IMAGE_BATCH') {
    fetchImageBatch(msg.limit, msg.offset).then(sendResponse);
    return true;
  }

  if (msg.type === 'FETCH_IMAGE_BLOB') {
    fetchImageBlob(msg.url).then(sendResponse);
    return true;
  }
});

async function apiFetch(url) {
  if (!authToken) {
    throw new Error('認証トークンがありません');
  }
  return fetch(url, {
    headers: {
      'Authorization': authToken,
      'Accept': '*/*'
    }
  });
}

async function fetchAllImages(maxCount) {
  const PAGE_SIZE = 50;
  const allImages = [];
  let offset = 0;
  let hasNext = true;

  try {
    while (hasNext) {
      const remaining = maxCount > 0 ? maxCount - allImages.length : PAGE_SIZE;
      const limit = maxCount > 0 ? Math.min(PAGE_SIZE, remaining) : PAGE_SIZE;
      if (maxCount > 0 && remaining <= 0) break;

      const url = `https://api.avalab.ai/v1/user/current/generated-image?l=${limit}&o=${offset}`;
      const res = await apiFetch(url);

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          authToken = null;
          return { error: 'トークンが期限切れです。avalab.ai のページをリロードしてから再試行してください。' };
        }
        return { error: `API エラー: ${res.status}` };
      }

      const data = await res.json();
      const images = data.images.filter((img) => img.status === 'success');
      allImages.push(...images);
      hasNext = data.has_next;
      offset += limit;
    }
    return { images: allImages };
  } catch (e) {
    return { error: e.message };
  }
}

// Fetch a single batch with fresh URLs
async function fetchImageBatch(limit, offset) {
  try {
    const url = `https://api.avalab.ai/v1/user/current/generated-image?l=${limit}&o=${offset}`;
    const res = await apiFetch(url);

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        authToken = null;
        return { error: 'トークンが期限切れです。avalab.ai のページをリロードしてから再試行してください。' };
      }
      return { error: `API エラー: ${res.status}` };
    }

    const data = await res.json();
    return { images: data.images, has_next: data.has_next };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchImageBlob(url) {
  try {
    if (!url) return { error: 'URLがnullです（画像が存在しない可能性）' };
    const res = await fetch(url);
    if (!res.ok) return { error: `画像取得失敗: HTTP ${res.status}` };
    const blob = await res.blob();
    const reader = new FileReader();
    return new Promise((resolve) => {
      reader.onloadend = () => resolve({ dataUrl: reader.result });
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return { error: `${e.message} (URL: ${url ? url.substring(0, 80) + '...' : 'null'})` };
  }
}

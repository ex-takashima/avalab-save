let allImages = [];

const $ = (sel) => document.querySelector(sel);
const BATCH_SIZE = 50; // Download in batches to avoid URL expiry

// --- Send message to background ---
async function sendToBg(msg) {
  return chrome.runtime.sendMessage(msg);
}

// --- UI helpers ---
function showStatus(text, pct) {
  $('#status').hidden = false;
  $('#status-text').textContent = text;
  $('#progress').style.width = pct + '%';
}

function hideStatus() {
  $('#status').hidden = true;
}

function showError(msg) {
  $('#error').hidden = false;
  $('#error').textContent = msg;
}

function clearError() {
  $('#error').hidden = true;
}

// --- Check login ---
async function checkLogin() {
  try {
    const result = await sendToBg({ type: 'CHECK_LOGIN' });
    if (result.loggedIn) {
      $('#login-status').textContent = 'ログイン済み（トークン取得済）';
      $('#login-status').className = 'login-ok';
      $('#btn-fetch').disabled = false;
      $('#btn-retry').hidden = true;
    } else {
      await requestTokenFromPage();
      const result2 = await sendToBg({ type: 'CHECK_LOGIN' });
      if (result2.loggedIn) {
        $('#login-status').textContent = 'ログイン済み（トークン取得済）';
        $('#login-status').className = 'login-ok';
        $('#btn-fetch').disabled = false;
        $('#btn-retry').hidden = true;
      } else {
        $('#login-status').textContent = 'トークン未取得 - avalab.ai をリロードしてください';
        $('#login-status').className = 'login-ng';
        $('#btn-fetch').disabled = true;
        $('#btn-retry').hidden = false;
      }
    }
  } catch (e) {
    $('#login-status').textContent = 'エラー: ' + e.message;
    $('#login-status').className = 'login-ng';
    $('#btn-fetch').disabled = true;
    $('#btn-retry').hidden = false;
  }
}

async function requestTokenFromPage() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://avalab.ai/*' });
    if (tabs.length === 0) return;
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'REQUEST_TOKEN' });
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    // content script may not be loaded
  }
}

// --- Render image list ---
function renderImageList(images) {
  const list = $('#image-list');
  list.innerHTML = '';

  images.forEach((img, i) => {
    const div = document.createElement('div');
    div.className = 'image-item';

    const date = new Date(img.created_at);
    const dateStr = date.toLocaleDateString('ja-JP') + ' ' +
      date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const promptPreview = img.positive_prompt || '(プロンプトなし)';

    div.innerHTML = `
      <input type="checkbox" data-index="${i}" checked>
      <img src="${img.thumbnail_url}" alt="">
      <div class="info">
        <div class="date">${dateStr}</div>
        <div class="prompt" title="${promptPreview}">${promptPreview}</div>
      </div>
    `;
    list.appendChild(div);
  });

  $('#result-text').textContent = `${images.length}件の画像が見つかりました`;
  $('#result').hidden = false;
}

// --- Build prompt text ---
function buildPromptText(img) {
  const lines = [];
  lines.push('[Positive Prompt]');
  lines.push(img.positive_prompt || '');
  lines.push('');
  if (img.negative_prompt) {
    lines.push('[Negative Prompt]');
    lines.push(img.negative_prompt);
    lines.push('');
  }
  lines.push('[Settings]');
  lines.push(`Fidelity: ${img.fidelity}`);
  lines.push(`LoRA ID: ${img.lora_id}`);
  lines.push(`Generated: ${img.generated_at}`);
  lines.push(`Image ID: ${img.id}`);
  return lines.join('\n');
}

// --- dataURL to Uint8Array ---
function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return arr;
}

// --- Download as ZIP (batch mode) ---
async function downloadAsZip() {
  const checkboxes = document.querySelectorAll('#image-list input[type="checkbox"]:checked');
  if (checkboxes.length === 0) {
    showError('ダウンロードする画像を選択してください。');
    return;
  }

  clearError();
  const zip = new JSZip();
  const selectedIndices = [...checkboxes].map((cb) => parseInt(cb.dataset.index));
  const failedImages = [];
  let done = 0;
  const total = selectedIndices.length;

  // Group selected images by their original API offset position
  // so we can re-fetch fresh URLs in batches
  let offset = 0;
  let hasNext = true;

  while (offset < allImages.length && hasNext) {
    // Find which selected images fall within this batch range
    const batchEnd = offset + BATCH_SIZE;
    const batchIndices = selectedIndices.filter(i => i >= offset && i < batchEnd);

    if (batchIndices.length > 0) {
      // Re-fetch this batch from API to get fresh URLs
      showStatus(`URL更新中... (バッチ ${Math.floor(offset / BATCH_SIZE) + 1})`, (done / total) * 100);
      const batchResult = await sendToBg({
        type: 'FETCH_IMAGE_BATCH',
        limit: BATCH_SIZE,
        offset: offset
      });

      if (batchResult.error) {
        showError(batchResult.error);
        return;
      }

      const freshImages = batchResult.images;
      hasNext = batchResult.has_next;

      // Build a map of image ID -> fresh image data
      const freshMap = {};
      for (const img of freshImages) {
        freshMap[img.id] = img;
      }

      // Download images in this batch
      for (const idx of batchIndices) {
        const originalImg = allImages[idx];
        // Use fresh URL if available, fall back to original
        const img = freshMap[originalImg.id] || originalImg;

        const date = new Date(img.created_at);
        const dateStr = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0'),
        ].join('');

        const baseName = `avalab_${dateStr}_${img.id}`;
        showStatus(`ダウンロード中... (${done + 1}/${total})`, (done / total) * 100);

        let success = false;
        for (let retry = 0; retry < 3; retry++) {
          try {
            if (retry > 0) {
              showStatus(`リトライ中... (${done + 1}/${total}) 試行${retry + 1}/3`, (done / total) * 100);
              await new Promise(r => setTimeout(r, 1000 * retry));
            }
            const result = await sendToBg({ type: 'FETCH_IMAGE_BLOB', url: img.url });
            if (result.error) throw new Error(result.error);
            const data = dataUrlToUint8Array(result.dataUrl);
            zip.file(`${baseName}.png`, data);
            success = true;
            break;
          } catch (e) {
            console.error(`Failed to fetch image ${img.id} (attempt ${retry + 1}):`, e);
            if (retry === 2) {
              failedImages.push({
                baseName, id: img.id, error: e.message,
                hasUrl: !!img.url, status: img.status,
                urlPrefix: img.url ? img.url.substring(0, 80) : 'null'
              });
            }
          }
        }

        // Always save prompt text
        zip.file(`${baseName}.txt`, buildPromptText(img));
        done++;
        showStatus(`ダウンロード中... (${done}/${total})`, (done / total) * 100);
      }
    } else {
      // No selected images in this range, still need to check has_next
      // Do a lightweight fetch just to keep pagination in sync
      const batchResult = await sendToBg({
        type: 'FETCH_IMAGE_BATCH',
        limit: BATCH_SIZE,
        offset: offset
      });
      if (batchResult.error) break;
      hasNext = batchResult.has_next;
    }

    offset += BATCH_SIZE;
  }

  // Add failure report if any
  if (failedImages.length > 0) {
    const report = failedImages.map(f =>
      `${f.baseName}\n  エラー: ${f.error}\n  URL有無: ${f.hasUrl ? 'あり' : 'なし(null)'}\n  status: ${f.status}\n  URL先頭: ${f.urlPrefix}`
    ).join('\n\n');
    zip.file('_FAILED_DOWNLOADS.txt',
      `以下の画像のダウンロードに失敗しました（3回リトライ済み）:\n\n${report}\n\n` +
      `画像一覧を再取得してからやり直すと、新しいURLで取得できる場合があります。`);
  }

  showStatus('ZIPファイルを生成中...', 100);
  const content = await zip.generateAsync({ type: 'blob' });

  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('');

  const a = document.createElement('a');
  a.href = URL.createObjectURL(content);
  a.download = `avalab_images_${timestamp}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);

  // Uncheck successfully downloaded images, keep only failed ones checked
  if (failedImages.length > 0) {
    const failedIds = new Set(failedImages.map(f => f.id));
    document.querySelectorAll('#image-list input[type="checkbox"]').forEach((cb) => {
      const idx = parseInt(cb.dataset.index);
      const img = allImages[idx];
      if (!failedIds.has(img.id)) {
        cb.checked = false; // success → uncheck
      }
    });
    showStatus(`完了! ${total - failedImages.length}/${total}件を保存（${failedImages.length}件失敗 → チェック残り）`, 100);
  } else {
    document.querySelectorAll('#image-list input[type="checkbox"]').forEach((cb) => (cb.checked = false));
    showStatus(`完了! ${total}件の画像をZIPで保存しました。`, 100);
  }
}

// --- Download to folder (File System Access API) ---
async function downloadToFolder() {
  const checkboxes = document.querySelectorAll('#image-list input[type="checkbox"]:checked');
  if (checkboxes.length === 0) {
    showError('ダウンロードする画像を選択してください。');
    return;
  }

  // Request folder access from user
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') return; // User cancelled
    showError('フォルダの選択に失敗しました: ' + e.message);
    return;
  }

  clearError();
  const selectedIndices = [...checkboxes].map((cb) => parseInt(cb.dataset.index));
  const failedImages = [];
  let done = 0;
  const total = selectedIndices.length;

  let offset = 0;
  let hasNext = true;

  while (offset < allImages.length && hasNext) {
    const batchEnd = offset + BATCH_SIZE;
    const batchIndices = selectedIndices.filter(i => i >= offset && i < batchEnd);

    if (batchIndices.length > 0) {
      showStatus(`URL更新中... (バッチ ${Math.floor(offset / BATCH_SIZE) + 1})`, (done / total) * 100);
      const batchResult = await sendToBg({
        type: 'FETCH_IMAGE_BATCH',
        limit: BATCH_SIZE,
        offset: offset
      });

      if (batchResult.error) {
        showError(batchResult.error);
        return;
      }

      const freshImages = batchResult.images;
      hasNext = batchResult.has_next;

      const freshMap = {};
      for (const img of freshImages) {
        freshMap[img.id] = img;
      }

      for (const idx of batchIndices) {
        const originalImg = allImages[idx];
        const img = freshMap[originalImg.id] || originalImg;

        const date = new Date(img.created_at);
        const dateStr = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0'),
        ].join('');

        const baseName = `avalab_${dateStr}_${img.id}`;
        showStatus(`ダウンロード中... (${done + 1}/${total})`, (done / total) * 100);

        let success = false;
        for (let retry = 0; retry < 3; retry++) {
          try {
            if (retry > 0) {
              showStatus(`リトライ中... (${done + 1}/${total}) 試行${retry + 1}/3`, (done / total) * 100);
              await new Promise(r => setTimeout(r, 1000 * retry));
            }
            const result = await sendToBg({ type: 'FETCH_IMAGE_BLOB', url: img.url });
            if (result.error) throw new Error(result.error);
            const data = dataUrlToUint8Array(result.dataUrl);

            // Write image file directly to folder
            const imgFile = await dirHandle.getFileHandle(`${baseName}.png`, { create: true });
            const imgWritable = await imgFile.createWritable();
            await imgWritable.write(data);
            await imgWritable.close();

            success = true;
            break;
          } catch (e) {
            console.error(`Failed to fetch image ${img.id} (attempt ${retry + 1}):`, e);
            if (retry === 2) {
              failedImages.push({
                baseName, id: img.id, error: e.message,
                hasUrl: !!img.url, status: img.status,
                urlPrefix: img.url ? img.url.substring(0, 80) : 'null'
              });
            }
          }
        }

        // Write prompt text file
        const txtFile = await dirHandle.getFileHandle(`${baseName}.txt`, { create: true });
        const txtWritable = await txtFile.createWritable();
        await txtWritable.write(buildPromptText(img));
        await txtWritable.close();

        done++;
        showStatus(`ダウンロード中... (${done}/${total})`, (done / total) * 100);
      }
    } else {
      const batchResult = await sendToBg({
        type: 'FETCH_IMAGE_BATCH',
        limit: BATCH_SIZE,
        offset: offset
      });
      if (batchResult.error) break;
      hasNext = batchResult.has_next;
    }

    offset += BATCH_SIZE;
  }

  // Write failure report if any
  if (failedImages.length > 0) {
    const report = failedImages.map(f =>
      `${f.baseName}\n  エラー: ${f.error}\n  URL有無: ${f.hasUrl ? 'あり' : 'なし(null)'}\n  status: ${f.status}\n  URL先頭: ${f.urlPrefix}`
    ).join('\n\n');
    const failFile = await dirHandle.getFileHandle('_FAILED_DOWNLOADS.txt', { create: true });
    const failWritable = await failFile.createWritable();
    await failWritable.write(
      `以下の画像のダウンロードに失敗しました（3回リトライ済み）:\n\n${report}\n\n` +
      `画像一覧を再取得してからやり直すと、新しいURLで取得できる場合があります。`);
    await failWritable.close();
  }

  // Uncheck successfully downloaded images
  if (failedImages.length > 0) {
    const failedIds = new Set(failedImages.map(f => f.id));
    document.querySelectorAll('#image-list input[type="checkbox"]').forEach((cb) => {
      const idx = parseInt(cb.dataset.index);
      const img = allImages[idx];
      if (!failedIds.has(img.id)) {
        cb.checked = false;
      }
    });
    showStatus(`完了! ${total - failedImages.length}/${total}件を保存（${failedImages.length}件失敗 → チェック残り）`, 100);
  } else {
    document.querySelectorAll('#image-list input[type="checkbox"]').forEach((cb) => (cb.checked = false));
    showStatus(`完了! ${total}件の画像をフォルダに保存しました。`, 100);
  }
}

// --- Fetch images page by page from popup (avoids SW timeout) ---
async function fetchAllImagesPaged(maxCount, dateFrom, dateTo) {
  const images = [];
  let offset = 0;
  let hasNext = true;

  while (hasNext) {
    const remaining = maxCount > 0 ? maxCount - images.length : BATCH_SIZE;
    const limit = maxCount > 0 ? Math.min(BATCH_SIZE, remaining) : BATCH_SIZE;
    if (maxCount > 0 && remaining <= 0) break;

    showStatus(`画像情報を取得中... (${images.length}件取得済)`, 0);

    const result = await sendToBg({
      type: 'FETCH_IMAGE_BATCH',
      limit,
      offset
    });

    if (result.error) throw new Error(result.error);

    let batch = result.images.filter((img) => img.status === 'success');

    // Date filter
    if (dateFrom) {
      const from = new Date(dateFrom + 'T00:00:00Z');
      batch = batch.filter(img => new Date(img.created_at) >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo + 'T23:59:59Z');
      batch = batch.filter(img => new Date(img.created_at) <= to);
    }

    images.push(...batch);
    hasNext = result.has_next;
    offset += limit;

    // If dateFrom is set and we've gone past it (images are sorted newest first),
    // check if we should stop
    if (dateFrom && result.images.length > 0) {
      const oldest = result.images[result.images.length - 1];
      if (new Date(oldest.created_at) < new Date(dateFrom + 'T00:00:00Z')) {
        break; // All remaining images are older than dateFrom
      }
    }
  }

  return images;
}

// --- Event listeners ---
$('#btn-fetch').addEventListener('click', async () => {
  clearError();
  $('#result').hidden = true;
  $('#btn-fetch').disabled = true;

  try {
    const maxCount = parseInt($('#limit').value);
    const dateFrom = $('#date-from').value || null;
    const dateTo = $('#date-to').value || null;

    const images = await fetchAllImagesPaged(maxCount, dateFrom, dateTo);

    if (images.length === 0) {
      showError('該当する生成画像が見つかりませんでした。');
      hideStatus();
    } else {
      allImages = images;
      hideStatus();
      renderImageList(allImages);
    }
  } catch (e) {
    showError(e.message);
    hideStatus();
  } finally {
    $('#btn-fetch').disabled = false;
  }
});

$('#btn-download').addEventListener('click', async () => {
  $('#btn-download').disabled = true;
  const mode = document.querySelector('input[name="save-mode"]:checked').value;
  try {
    if (mode === 'folder') {
      await downloadToFolder();
    } else {
      await downloadAsZip();
    }
  } catch (e) {
    showError((mode === 'folder' ? 'フォルダ保存' : 'ZIPダウンロード') + 'に失敗しました: ' + e.message);
  } finally {
    $('#btn-download').disabled = false;
  }
});

$('#btn-select-all').addEventListener('click', () => {
  document.querySelectorAll('#image-list input[type="checkbox"]').forEach((cb) => (cb.checked = true));
});

$('#btn-deselect-all').addEventListener('click', () => {
  document.querySelectorAll('#image-list input[type="checkbox"]').forEach((cb) => (cb.checked = false));
});

// --- Load failed list from txt file ---
$('#file-failed').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    const text = ev.target.result;
    // Extract image IDs from failed list (format: avalab_YYYYMMDD_IMAGEID)
    const failedIds = new Set();
    for (const line of text.split('\n')) {
      const match = line.match(/^avalab_\d{8}_(.+?)$/);
      if (match) {
        failedIds.add(match[1]);
      }
    }

    if (failedIds.size === 0) {
      showError('失敗リストからIDを読み取れませんでした。');
      return;
    }

    // Check only failed images, uncheck all others
    let matched = 0;
    document.querySelectorAll('#image-list input[type="checkbox"]').forEach((cb) => {
      const idx = parseInt(cb.dataset.index);
      const img = allImages[idx];
      if (failedIds.has(img.id)) {
        cb.checked = true;
        matched++;
      } else {
        cb.checked = false;
      }
    });

    clearError();
    showStatus(`失敗リストから ${matched}件を選択しました。`, 100);
    // Reset file input
    e.target.value = '';
  };
  reader.readAsText(file);
});

$('#btn-retry').addEventListener('click', () => {
  $('#login-status').textContent = '確認中...';
  $('#login-status').className = 'login-checking';
  $('#btn-retry').hidden = true;
  checkLogin();
});

// --- Init ---
checkLogin();

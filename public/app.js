const form = document.querySelector('#uploadForm');
const input = document.querySelector('#images');
const dropzone = document.querySelector('.dropzone');
const button = document.querySelector('#processButton');
const statusEl = document.querySelector('#status span:last-child');
const resultsList = document.querySelector('#resultsList');
const refreshButton = document.querySelector('#refreshButton');
const folderHint = document.querySelector('#folderHint');
const selectionState = document.querySelector('#selectionState');
let selectedFiles = [];

function renderItems(items) {
  if (!items || items.length === 0) {
    resultsList.innerHTML = '<p class="empty">No processed images yet.</p>';
    return;
  }

  resultsList.innerHTML = items.map(item => {
    const ok = item.status === 'ok';
    const title = item.originalName || item.source || 'Image';
    const detail = ok ? item.output : (item.error || 'Processing failed.');
    const link = ok && item.downloadUrl ? `<a class="download" href="${escapeHtml(item.downloadUrl)}">Download</a>` : '';
    return `
      <article class="item ${ok ? '' : 'error'}">
        <span class="badge">${ok ? 'Saved' : 'Error'}</span>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <code>${escapeHtml(detail)}</code>
          ${link}
        </div>
      </article>
    `;
  }).join('');
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function refreshStatus() {
  const response = await fetch('/api/status');
  const data = await response.json();
  statusEl.textContent = data.mode === 'web+watch' ? 'Web + watcher' : data.mode;
  folderHint.textContent = data.outputDir
    ? `Outputs are saved to ${data.outputDir}`
    : 'Outputs are saved to the local outputs folder unless --output is set.';
  renderItems(data.recent);
}

async function processImages(event) {
  if (event) event.preventDefault();
  const files = selectedFiles.length > 0 ? selectedFiles : Array.from(input.files || []);
  if (files.length === 0) {
    selectionState.textContent = 'Choose at least one image';
    return;
  }

  button.disabled = true;
  button.textContent = 'Processing...';
  selectionState.textContent = `Processing ${files.length} image${files.length === 1 ? '' : 's'}...`;
  const formData = new FormData();
  files.forEach(file => formData.append('images', file));
  formData.append('format', document.querySelector('#format').value);
  formData.append('quality', document.querySelector('#quality').value);

  try {
    const response = await fetch('/api/process', { method: 'POST', body: formData });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Upload failed.');
    renderItems(data.results);
    input.value = '';
    selectedFiles = [];
    selectionState.textContent = 'Done. Choose more images';
    await refreshStatus();
  } catch (error) {
    renderItems([{ status: 'error', source: 'Upload', error: error.message }]);
    selectionState.textContent = 'Upload failed';
  } finally {
    button.disabled = false;
    button.textContent = 'Process images';
  }
}

function setFiles(files) {
  selectedFiles = Array.from(files || []).filter(file => file.type.startsWith('image/'));
  if (selectedFiles.length === 0) {
    selectionState.textContent = 'No supported images selected';
    return;
  }
  selectionState.textContent = `${selectedFiles.length} image${selectedFiles.length === 1 ? '' : 's'} selected`;
  processImages();
}

['dragenter', 'dragover'].forEach(eventName => {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach(eventName => {
  dropzone.addEventListener(eventName, event => {
    event.preventDefault();
    dropzone.classList.remove('dragover');
  });
});

dropzone.addEventListener('drop', event => {
  setFiles(event.dataTransfer.files);
});

form.addEventListener('submit', processImages);
input.addEventListener('change', () => setFiles(input.files));
refreshButton.addEventListener('click', refreshStatus);
refreshStatus().catch(() => {
  statusEl.textContent = 'Offline';
});

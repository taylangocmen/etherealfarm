/* Runs in the extension's isolated world; page code has no Chrome API access. */
(() => {
  const key = 'run-charts-v1:' + location.origin + location.pathname;
  const channel = 'ethereal-run-charts-v1';
  window.addEventListener('message', async event => {
    if (event.source !== window || event.data?.channel !== channel) return;
    const { type, data } = event.data;
    try {
      if (type === 'load') {
        const result = await chrome.storage.local.get(key);
        window.postMessage({ channel, type: 'loaded', data: result[key] || null }, '*');
      } else if (type === 'save') {
        if (data?.version !== 1 || !Array.isArray(data.runs) || data.runs.length > 10 || JSON.stringify(data).length >= 4000000) throw Error('Chart history exceeds storage budget');
        await chrome.storage.local.set({ [key]: data });
        window.postMessage({ channel, type: 'saved' }, '*');
      }
    } catch (error) {
      window.postMessage({ channel, type: 'error', message: String(error.message) }, '*');
    }
  });
})();

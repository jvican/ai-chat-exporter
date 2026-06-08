(() => {
  const source = 'chatgpt-exporter';
  const originalClipboard = navigator.clipboard;
  const originalWriteTextDescriptor = originalClipboard
    ? Object.getOwnPropertyDescriptor(originalClipboard, 'writeText')
    : null;
  const originalWriteDescriptor = originalClipboard
    ? Object.getOwnPropertyDescriptor(originalClipboard, 'write')
    : null;
  const originalWriteText = originalClipboard?.writeText?.bind(originalClipboard);
  const originalWrite = originalClipboard?.write?.bind(originalClipboard);

  let activeCapture = null;
  let timeoutId = null;
  let wrapped = false;

  const post = message => window.postMessage({ source, ...message }, '*');

  const clearCaptureTimeout = () => {
    if (!timeoutId) return;
    clearTimeout(timeoutId);
    timeoutId = null;
  };

  const restoreClipboard = () => {
    clearCaptureTimeout();
    activeCapture = null;

    if (!wrapped) return;
    wrapped = false;

    try {
      if (originalClipboard) {
        if (originalWriteTextDescriptor) {
          Object.defineProperty(originalClipboard, 'writeText', originalWriteTextDescriptor);
        } else {
          delete originalClipboard.writeText;
        }
      }

      if (originalClipboard) {
        if (originalWriteDescriptor) {
          Object.defineProperty(originalClipboard, 'write', originalWriteDescriptor);
        } else {
          delete originalClipboard.write;
        }
      }
    } catch (error) {}
  };

  const capture = text => {
    const requestId = activeCapture?.requestId;
    clearCaptureTimeout();
    activeCapture = null;
    post({
      type: 'clipboard-captured',
      requestId,
      text: String(text || '')
    });
    return Promise.resolve();
  };

  const extractClipboardItemText = async items => {
    for (const item of items || []) {
      const types = Array.from(item.types || []);
      const type = types.find(value => value === 'text/markdown') ||
        types.find(value => value === 'text/plain') ||
        types.find(value => value.startsWith('text/'));

      if (!type) continue;

      try {
        const blob = await item.getType(type);
        return await blob.text();
      } catch (error) {}
    }

    return '';
  };

  const ensureWrapped = () => {
    if (wrapped) return true;

    try {
      if (originalClipboard && originalWriteText) {
        Object.defineProperty(originalClipboard, 'writeText', {
          value: text => activeCapture ? capture(text) : originalWriteText(text),
          configurable: true,
          writable: true
        });
      }

      if (originalClipboard && originalWrite) {
        Object.defineProperty(originalClipboard, 'write', {
          value: async items => {
            if (!activeCapture) return originalWrite(items);
            return capture(await extractClipboardItemText(items));
          },
          configurable: true,
          writable: true
        });
      }

      wrapped = true;
      return true;
    } catch (error) {
      restoreClipboard();
      return false;
    }
  };

  const armCapture = ({ requestId, timeoutMs }) => {
    if (!requestId || !ensureWrapped()) {
      post({ type: 'clipboard-capture-timeout', requestId });
      return;
    }

    clearCaptureTimeout();
    activeCapture = { requestId };

    timeoutId = setTimeout(() => {
      activeCapture = null;
      timeoutId = null;
      post({ type: 'clipboard-capture-timeout', requestId });
    }, Number(timeoutMs) || 8000);

    post({ type: 'clipboard-capture-armed', requestId });
  };

  window.addEventListener('message', event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== source) return;

    if (data.type === 'manager-ping') {
      post({ type: 'manager-ready' });
    } else if (data.type === 'arm-capture') {
      armCapture(data);
    } else if (data.type === 'disarm-capture') {
      if (!data.requestId || activeCapture?.requestId === data.requestId) {
        clearCaptureTimeout();
        activeCapture = null;
      }
    } else if (data.type === 'restore-capture') {
      restoreClipboard();
    }
  });

  post({ type: 'manager-ready' });
})();

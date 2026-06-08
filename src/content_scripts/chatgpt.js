
/**
 * ChatGPT Chat Exporter - Content script
 * Adds an export UI, lets users pick which messages to include,
 * and downloads/copies perfectly formatted Markdown.
 */

(function() {
  'use strict';

  // ============================================================================
  // CONSTANTS
  // ============================================================================
  const CONFIG = {
    BUTTON_ID: 'chatgpt-export-btn',
    DROPDOWN_ID: 'chatgpt-export-dropdown',
    FILENAME_INPUT_ID: 'chatgpt-filename-input',
    SELECT_DROPDOWN_ID: 'chatgpt-select-dropdown',
    CHECKBOX_CLASS: 'chatgpt-export-checkbox',
    EXPORT_MODE_NAME: 'chatgpt-export-mode',

    SELECTORS: {
      CONVERSATION_TURNS: [
        'section[data-testid^="conversation-turn-"][data-turn]',
        'article[data-testid^="conversation-turn-"]'
      ],
      MESSAGE_NODE: '[data-message-author-role]',
      ASSISTANT_MARKDOWN: '[data-message-author-role="assistant"] .markdown',
      ASSISTANT_TEXT: '[data-message-author-role="assistant"], .markdown, .prose',
      USER_TEXT: '[data-message-author-role="user"] .whitespace-pre-wrap, .whitespace-pre-wrap',
      COPY_BUTTON: 'button[data-testid="copy-turn-action-button"]',
      THREAD_TITLE: 'main h1'
    },

    CHAT_CONTAINER_CANDIDATES: [
      'div[data-testid="conversation-turns"]',
      'div[aria-label="Chat history"]',
      'div.flex.h-full.flex-col.overflow-y-auto',
      'div.flex.h-full.w-full.flex-col.overflow-y-auto',
      'main div.flex-1.overflow-y-auto',
      'main div.overflow-y-auto'
    ],

    TIMING: {
      SCROLL_DELAY: 2000,
      MAX_SCROLL_ATTEMPTS: 60,
      MAX_STABLE_SCROLLS: 4,
      CLIPBOARD_CLEAR_DELAY: 150,
      CLIPBOARD_CAPTURE_TIMEOUT: 3000,
      POPUP_DURATION: 1000
    },

    DEBUG_COPY_CAPTURE: false,
    DEBUG_TURNS: false,

    STYLES: {
      BUTTON_PRIMARY: '#1a73e8',
      BUTTON_HOVER: '#1765c1',
      DARK_BG: '#111',
      DARK_TEXT: '#fff',
      DARK_BORDER: '#444',
      LIGHT_BG: '#fff',
      LIGHT_TEXT: '#222',
      LIGHT_BORDER: '#ccc'
    }
  };

  // ============================================================================
  // UTILITIES
  // ============================================================================
  const Utils = {
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    isDarkMode() {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    },

    sanitizeFilename(text) {
      return text
        .replace(/[\\/:*?"<>|.]/g, '')
        .replace(/[\s_]+/g, ' ')
        .trim();
    },

    getDateString() {
      const d = new Date();
      const pad = n => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    },

    createNotification(message) {
      const popup = document.createElement('div');
      Object.assign(popup.style, {
        position: 'fixed',
        top: '24px',
        right: '24px',
        zIndex: '99999',
        background: '#333',
        color: '#fff',
        padding: '9px 16px',
        borderRadius: '6px',
        fontSize: '0.95em',
        boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
        pointerEvents: 'none'
      });
      popup.textContent = message;
      document.body.appendChild(popup);
      setTimeout(() => popup.remove(), CONFIG.TIMING.POPUP_DURATION);
      return popup;
    },

    getConversationTurns() {
      return Utils.getAllConversationTurnCandidates();
    },

    getAllConversationTurnCandidates() {
      const seen = new Set();
      const turns = [];

      CONFIG.SELECTORS.CONVERSATION_TURNS.forEach(selector => {
        document.querySelectorAll(selector).forEach(turn => {
          if (seen.has(turn)) return;
          seen.add(turn);
          turns.push(turn);
        });
      });

      return turns.sort((a, b) => {
        const position = a.compareDocumentPosition(b);
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        return 0;
      });
    },

    normalizeText(text) {
      return (text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
    }
  };

  // ============================================================================
  // CHECKBOX MANAGER
  // ============================================================================
  class CheckboxManager {
    resolveTurnRole(turn) {
      const messageRole = turn.querySelector(CONFIG.SELECTORS.MESSAGE_NODE)?.dataset.messageAuthorRole;
      if (messageRole === 'user') return 'user';
      if (messageRole === 'assistant') return 'model';

      const turnRole = turn.dataset.turn;
      if (turnRole === 'user' && turn.querySelector(CONFIG.SELECTORS.USER_TEXT)) return 'user';
      if (turnRole === 'assistant' && (
        turn.querySelector(CONFIG.SELECTORS.ASSISTANT_MARKDOWN) ||
        turn.querySelector(CONFIG.SELECTORS.ASSISTANT_TEXT)
      )) return 'model';

      if (turn.querySelector(CONFIG.SELECTORS.ASSISTANT_MARKDOWN) ||
          turn.querySelector(CONFIG.SELECTORS.ASSISTANT_TEXT)) {
        return 'model';
      }

      if (turn.querySelector(CONFIG.SELECTORS.USER_TEXT)) return 'user';

      return null;
    }

    create(turn, type, topOffset) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = `${CONFIG.CHECKBOX_CLASS} ${type}`;
      checkbox.checked = true;
      checkbox.title = `Include this ${type === 'user' ? 'user' : 'ChatGPT'} message`;

      Object.assign(checkbox.style, {
        position: 'absolute',
        right: '28px',
        top: topOffset,
        zIndex: '10000',
        transform: 'scale(1.2)'
      });

      if (turn.style.position !== 'relative') {
        turn.style.position = 'relative';
      }

      turn.appendChild(checkbox);
      return checkbox;
    }

    injectCheckboxes() {
      const turns = Utils.getConversationTurns();

      turns.forEach(turn => {
        const role = this.resolveTurnRole(turn);
        if (role && !turn.querySelector(`.${CONFIG.CHECKBOX_CLASS}.${role}`)) {
          this.create(turn, role, '8px');
        }
      });
    }

    removeAll() {
      document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`).forEach(cb => cb.remove());
    }

    anyChecked() {
      return Array.from(document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`)).some(cb => cb.checked);
    }
  }

  // ============================================================================
  // SELECTION MANAGER
  // ============================================================================
  class SelectionManager {
    constructor() {
      this.lastSelection = 'all';
    }

    apply(value) {
      switch (value) {
        case 'all':
          document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`).forEach(cb => cb.checked = true);
          break;
        case 'ai':
          document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}.user`).forEach(cb => cb.checked = false);
          document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}.model`).forEach(cb => cb.checked = true);
          break;
        case 'none':
          document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`).forEach(cb => cb.checked = false);
          break;
      }
      this.lastSelection = value;
    }

    syncWithDropdown() {
      const dropdown = document.getElementById(CONFIG.SELECT_DROPDOWN_ID);
      const value = dropdown?.value || this.lastSelection;
      if (value && value !== 'custom') {
        this.apply(value);
      }
    }

    resetDropdown() {
      const dropdown = document.getElementById(CONFIG.SELECT_DROPDOWN_ID);
      if (dropdown) {
        dropdown.value = 'all';
      }
      this.lastSelection = 'all';
    }
  }

  // ============================================================================
  // UI BUILDER
  // ============================================================================
  class UIBuilder {
    static getInputStyles() {
      const isDark = Utils.isDarkMode();
      return isDark
        ? `background:${CONFIG.STYLES.DARK_BG};color:${CONFIG.STYLES.DARK_TEXT};border:1px solid ${CONFIG.STYLES.DARK_BORDER};`
        : `background:${CONFIG.STYLES.LIGHT_BG};color:${CONFIG.STYLES.LIGHT_TEXT};border:1px solid ${CONFIG.STYLES.LIGHT_BORDER};`;
    }

    static createButton() {
      const button = document.createElement('button');
      button.id = CONFIG.BUTTON_ID;
      button.textContent = 'Export Chat';

      Object.assign(button.style, {
        position: 'fixed',
        top: '80px',
        right: '20px',
        zIndex: '9999',
        padding: '8px 16px',
        background: CONFIG.STYLES.BUTTON_PRIMARY,
        color: '#fff',
        border: 'none',
        borderRadius: '6px',
        fontSize: '1em',
        fontWeight: 'bold',
        cursor: 'pointer',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        transition: 'background 0.2s'
      });

      button.addEventListener('mouseenter', () => button.style.background = CONFIG.STYLES.BUTTON_HOVER);
      button.addEventListener('mouseleave', () => button.style.background = CONFIG.STYLES.BUTTON_PRIMARY);

      return button;
    }

    static createDropdown() {
      const dropdown = document.createElement('div');
      dropdown.id = CONFIG.DROPDOWN_ID;

      Object.assign(dropdown.style, {
        position: 'fixed',
        top: '124px',
        right: '20px',
        zIndex: '9999',
        border: '1px solid #ccc',
        borderRadius: '6px',
        padding: '10px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        display: 'none',
        background: Utils.isDarkMode() ? '#222' : '#fff',
        color: Utils.isDarkMode() ? '#fff' : '#222'
      });

      const inputStyles = this.getInputStyles();

      dropdown.innerHTML = `
        <div style="margin-top:10px;">
          <label style="margin-right:10px;">
            <input type="radio" name="${CONFIG.EXPORT_MODE_NAME}" value="file" checked>
            Export as file
          </label>
          <label>
            <input type="radio" name="${CONFIG.EXPORT_MODE_NAME}" value="clipboard">
            Export to clipboard
          </label>
        </div>
        <div id="chatgpt-filename-row" style="margin-top:10px;display:block;">
          <label for="${CONFIG.FILENAME_INPUT_ID}" style="font-weight:bold;">
            Filename <span style="color:#888;font-weight:normal;">(optional)</span>:
          </label>
          <input id="${CONFIG.FILENAME_INPUT_ID}" type="text" value=""
                 style="margin-left:8px;padding:2px 8px;width:260px;${inputStyles}">
          <span style="display:block;font-size:0.93em;color:#888;margin-top:2px;">
            Leave blank to use chat title or a timestamp. Do not include an extension.
          </span>
        </div>
        <div style="margin-top:14px;">
          <label style="font-weight:bold;">Select messages:</label>
          <select id="${CONFIG.SELECT_DROPDOWN_ID}" style="margin-left:8px;padding:2px 8px;${inputStyles}">
            <option value="all">All</option>
            <option value="ai">Only answers</option>
            <option value="none">None</option>
            <option value="custom">Custom</option>
          </select>
        </div>
      `;

      return dropdown;
    }
  }

  // ============================================================================
  // EXPORT SERVICE
  // ============================================================================
  class ExportService {
    constructor(checkboxManager) {
      this.checkboxManager = checkboxManager;
    }

    getTurns() {
      return Utils.getConversationTurns();
    }

    getMessageRecords() {
      return Array.from(document.querySelectorAll(CONFIG.SELECTORS.MESSAGE_NODE))
        .map((node, index) => {
          const authorRole = node.dataset.messageAuthorRole;
          const role = authorRole === 'assistant'
            ? 'model'
            : authorRole === 'user'
              ? 'user'
              : null;

          if (!role) return null;

          return {
            index,
            node,
            role,
            turn: this.getTurnForMessageNode(node)
          };
        })
        .filter(Boolean);
    }

    getTurnForMessageNode(node) {
      return CONFIG.SELECTORS.CONVERSATION_TURNS
        .map(selector => node.closest(selector))
        .find(Boolean) || node;
    }

    getChatContainer() {
      for (const selector of CONFIG.CHAT_CONTAINER_CANDIDATES) {
        const el = document.querySelector(selector);
        if (el) return el;
      }

      const firstTurn = this.getTurns()[0];
      if (firstTurn) {
        const overflowAncestor = firstTurn.closest('div.overflow-y-auto, div.flex-1, main');
        if (overflowAncestor) return overflowAncestor;
        return firstTurn.parentElement;
      }

      return null;
    }

    async scrollToLoadAll() {
      const container = this.getChatContainer();
      if (!container) {
        throw new Error('Could not find chat history container. Are you on a ChatGPT page?');
      }

      let stableScrolls = 0;
      let attempts = 0;
      let lastScrollTop = null;

      while (stableScrolls < CONFIG.TIMING.MAX_STABLE_SCROLLS && attempts < CONFIG.TIMING.MAX_SCROLL_ATTEMPTS) {
        const currentTurnCount = this.getTurns().length;
        container.scrollTop = 0;
        await Utils.sleep(CONFIG.TIMING.SCROLL_DELAY);

        const newTurnCount = this.getTurns().length;
        const currentTop = container.scrollTop;

        if (newTurnCount === currentTurnCount && (lastScrollTop === currentTop || currentTop === 0)) {
          stableScrolls++;
        } else {
          stableScrolls = 0;
        }

        lastScrollTop = currentTop;
        attempts++;
      }
    }

    getMessageRecordKey(record) {
      const turnId = record.turn?.getAttribute?.('data-testid') || '';
      if (turnId) return `${record.role}:${turnId}`;

      const text = Utils.normalizeText(record.node.textContent || '');
      return `${record.role}:${text.slice(0, 240)}`;
    }

    getTurnNumber(record) {
      const turnId = record.turn?.getAttribute?.('data-testid') || '';
      const match = turnId.match(/conversation-turn-(\d+)/);
      return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
    }

    shouldIncludeRecord(record, selectionMode) {
      if (selectionMode === 'none') return false;
      if (selectionMode === 'ai') return record.role === 'model';
      if (selectionMode === 'custom') return this.isMessageSelected(record);
      return true;
    }

    async collectMessageSnapshots(selectionMode = 'all') {
      const container = this.getChatContainer();
      const scrollTargets = Utils.getAllConversationTurnCandidates();
      const snapshotsByKey = new Map();

      this.logTurn('snapshot collection start', {
        wrappers: scrollTargets.length,
        mountedMessageNodes: this.getMessageRecords().length,
        selectionMode
      });

      const collectMounted = async source => {
        const records = this.getMessageRecords();
        this.logTurn('snapshot collection mounted records', {
          source,
          count: records.length,
          roles: records.map(record => record.role)
        });

        for (const record of records) {
          const key = this.getMessageRecordKey(record);
          if (!this.shouldIncludeRecord(record, selectionMode)) {
            this.logTurn('snapshot skipped by selection', {
              source,
              key,
              role: record.role,
              testId: record.turn?.getAttribute?.('data-testid') || ''
            });
            continue;
          }

          if (snapshotsByKey.has(key)) {
            this.logTurn('snapshot duplicate skipped', {
              source,
              key,
              role: record.role,
              testId: record.turn?.getAttribute?.('data-testid') || ''
            });
            continue;
          }

          const ordinal = snapshotsByKey.size + 1;
          const turnNumber = this.getTurnNumber(record);

          if (record.role === 'user') {
            const content = this.getMessageText(record.node, 'user');
            this.logTurn('snapshot user', {
              ordinal,
              key,
              turnNumber,
              contentLength: content.length,
              testId: record.turn?.getAttribute?.('data-testid') || ''
            });
            snapshotsByKey.set(key, { role: 'user', content, key, turnNumber });
            continue;
          }

          const copyBtn = this.findCopyButton(record);
          const fallbackText = this.getMessageText(record.node, 'model');
          this.logTurn('snapshot assistant before copy', {
            ordinal,
            key,
            turnNumber,
            hasResolvedCopyButton: Boolean(copyBtn),
            fallbackTextLength: fallbackText.length,
            testId: record.turn?.getAttribute?.('data-testid') || ''
          });

          const clipboardText = copyBtn ? await this.copyModelResponse(copyBtn) : '';
          const content = clipboardText || fallbackText;
          this.logTurn('snapshot assistant after copy', {
            ordinal,
            key,
            turnNumber,
            clipboardTextLength: clipboardText.length,
            finalContentLength: content.length,
            usedFallback: !clipboardText && Boolean(content)
          });
          snapshotsByKey.set(key, { role: 'model', content, key, turnNumber });
        }
      };

      await collectMounted('initial');

      for (let i = 0; i < scrollTargets.length; i++) {
        scrollTargets[i].scrollIntoView({ block: 'center', inline: 'nearest' });
        await Utils.sleep(300);
        await collectMounted(`scroll-${i + 1}`);
      }

      if (container) {
        container.scrollTop = container.scrollHeight;
        await Utils.sleep(250);
        await collectMounted('bottom');
      }

      const snapshots = Array.from(snapshotsByKey.values())
        .sort((a, b) => a.turnNumber - b.turnNumber);

      this.logTurn('snapshot collection complete', {
        snapshots: snapshots.length,
        roles: snapshots.map(snapshot => snapshot.role),
        turnNumbers: snapshots.map(snapshot => snapshot.turnNumber),
        keys: snapshots.map(snapshot => snapshot.key)
      });

      return snapshots;
    }

    logCopyCapture(message, details) {
      if (!CONFIG.DEBUG_COPY_CAPTURE) return;
      console.log('[ChatGPT Exporter copy capture]', message, details || '');
    }

    logTurn(message, details) {
      if (!CONFIG.DEBUG_TURNS) return;
      console.log('[ChatGPT Exporter turn]', message, details || '');
    }

    async ensureCopyCaptureManager() {
      if (this.copyCaptureManagerReady) return true;

      return new Promise(resolve => {
        const timeout = setTimeout(() => {
          window.removeEventListener('message', handleMessage);
          this.logCopyCapture('manager load timeout');
          resolve(false);
        }, 3000);

        const handleMessage = event => {
          if (event.source !== window) return;
          const data = event.data;
          if (!data || data.source !== 'chatgpt-exporter' || data.type !== 'manager-ready') return;

          clearTimeout(timeout);
          window.removeEventListener('message', handleMessage);
          this.copyCaptureManagerReady = true;
          this.logCopyCapture('manager ready');
          resolve(true);
        };

        window.addEventListener('message', handleMessage);

        const existingScript = document.querySelector('script[data-chatgpt-exporter-copy-manager="true"]');
        if (existingScript) {
          window.postMessage({ source: 'chatgpt-exporter', type: 'manager-ping' }, '*');
          return;
        }

        const script = document.createElement('script');
        try {
          script.src = chrome.runtime.getURL('src/content_scripts/chatgpt_clipboard_capture.js');
        } catch (error) {
          clearTimeout(timeout);
          window.removeEventListener('message', handleMessage);
          this.logCopyCapture('manager getURL error', error);
          resolve(false);
          return;
        }
        script.dataset.chatgptExporterCopyManager = 'true';
        script.onerror = () => {
          clearTimeout(timeout);
          window.removeEventListener('message', handleMessage);
          this.logCopyCapture('manager script load error');
          resolve(false);
        };
        (document.head || document.documentElement).appendChild(script);
      });
    }

    async restoreCopyCaptureManager() {
      if (!this.copyCaptureManagerReady) return;
      window.postMessage({ source: 'chatgpt-exporter', type: 'restore-capture' }, '*');
      this.copyCaptureManagerReady = false;
      this.logCopyCapture('manager restore requested');
    }

    async copyModelResponse(copyButton) {
      const managerReady = await this.ensureCopyCaptureManager();
      if (!managerReady) return '';

      const attemptCapture = attemptNumber => new Promise(resolve => {
        const requestId = `chatgpt-export-copy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timeoutMs = CONFIG.TIMING.CLIPBOARD_CAPTURE_TIMEOUT;
        let settled = false;
        let sawClipboardCall = false;
        const watchdog = setTimeout(() => finish('', 'content watchdog timeout'), timeoutMs + 1000);

        const cleanup = () => {
          clearTimeout(watchdog);
          window.removeEventListener('message', handleMessage);
          window.postMessage({ source: 'chatgpt-exporter', type: 'disarm-capture', requestId }, '*');
        };

        const finish = (text, reason) => {
          if (settled) return;
          settled = true;
          cleanup();
          this.logCopyCapture(reason, {
            attempt: attemptNumber,
            requestId,
            textLength: text?.length || 0,
            sawClipboardCall
          });
          resolve(text || '');
        };

        const handleMessage = event => {
          if (event.source !== window) return;
          const data = event.data;
          if (!data || data.source !== 'chatgpt-exporter' || data.requestId !== requestId) return;

          if (data.type === 'clipboard-captured') {
            sawClipboardCall = true;
            finish(data.text, 'captured');
          } else if (data.type === 'clipboard-capture-armed') {
            try {
              this.logCopyCapture('native copy click', { attempt: attemptNumber, requestId });
              copyButton.click();
            } catch (error) {
              finish('', 'native copy click failed');
            }
          } else if (data.type === 'clipboard-capture-timeout') {
            finish('', 'capture timeout');
          }
        };

        window.addEventListener('message', handleMessage);

        this.logCopyCapture('arm capture', { attempt: attemptNumber, requestId, timeoutMs });
        window.postMessage({
          source: 'chatgpt-exporter',
          type: 'arm-capture',
          requestId,
          timeoutMs
        }, '*');
      });

      const firstCapture = await attemptCapture(1);
      if (firstCapture) return firstCapture;

      await Utils.sleep(CONFIG.TIMING.CLIPBOARD_CLEAR_DELAY);
      return attemptCapture(2);
    }

    getConversationTitle() {
      const heading = document.querySelector(CONFIG.SELECTORS.THREAD_TITLE);
      if (heading?.textContent?.trim()) return heading.textContent.trim();
      return document.title?.trim() || '';
    }

    generateFilename(custom, title) {
      const baseTimestamp = Utils.getDateString();

      if (custom?.trim()) {
        const base = Utils.sanitizeFilename(custom.trim().replace(/\.[^/.]+$/, ''));
        return base || `chatgpt chat export ${baseTimestamp}`;
      }

      if (title) {
        const safe = Utils.sanitizeFilename(title);
        if (safe) return `${safe} ${baseTimestamp}`;
      }

      return `chatgpt chat export ${baseTimestamp}`;
    }

    getMessageNode(turnOrNode) {
      if (turnOrNode?.matches?.(CONFIG.SELECTORS.MESSAGE_NODE)) return turnOrNode;
      return turnOrNode?.querySelector?.(CONFIG.SELECTORS.MESSAGE_NODE) || null;
    }

    getVisibleText(el) {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll([
        `.${CONFIG.CHECKBOX_CLASS}`,
        'button',
        'svg',
        'path',
        'script',
        'style',
        'noscript'
      ].join(',')).forEach(node => node.remove());
      return Utils.normalizeText(clone.textContent);
    }

    getUserText(turnOrNode, messageNode) {
      const scopedUserNode = messageNode?.dataset.messageAuthorRole === 'user'
        ? messageNode
        : turnOrNode?.matches?.('[data-message-author-role="user"]')
          ? turnOrNode
          : null;
      const userTextNode = scopedUserNode?.querySelector(CONFIG.SELECTORS.USER_TEXT) ||
        turnOrNode.querySelector?.('[data-message-author-role="user"]') ||
        turnOrNode.querySelector?.(CONFIG.SELECTORS.USER_TEXT);

      return this.getVisibleText(userTextNode || scopedUserNode);
    }

    getModelText(turnOrNode, messageNode) {
      const markdownNode = turnOrNode.querySelector?.(CONFIG.SELECTORS.ASSISTANT_MARKDOWN) ||
        (turnOrNode.matches?.('.markdown') ? turnOrNode : null);
      const assistantNode = messageNode?.dataset.messageAuthorRole === 'assistant'
        ? messageNode
        : turnOrNode.matches?.('[data-message-author-role="assistant"]')
          ? turnOrNode
          : turnOrNode.querySelector?.('[data-message-author-role="assistant"]');
      const assistantTextNode = turnOrNode.querySelector?.(CONFIG.SELECTORS.ASSISTANT_TEXT);

      return this.getVisibleText(markdownNode || assistantNode || assistantTextNode || turnOrNode);
    }

    getMessageText(turnOrNode, role) {
      const messageNode = this.getMessageNode(turnOrNode);
      return role === 'model'
        ? this.getModelText(turnOrNode, messageNode)
        : this.getUserText(turnOrNode, messageNode);
    }

    findCopyButton(messageRecord) {
      const target = messageRecord.node;
      const turn = messageRecord.turn || target;

      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      turn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      turn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

      const scopedButton = turn.querySelector(CONFIG.SELECTORS.COPY_BUTTON);
      if (scopedButton) return scopedButton;

      const turnRect = target.getBoundingClientRect();
      const visibleButtons = Array.from(document.querySelectorAll(CONFIG.SELECTORS.COPY_BUTTON))
        .map(button => ({ button, rect: button.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0)
        .filter(({ rect }) => rect.top >= turnRect.top - 24)
        .filter(({ rect }) => rect.top <= turnRect.bottom + 96);

      return visibleButtons
        .sort((a, b) => Math.abs(a.rect.top - turnRect.bottom) - Math.abs(b.rect.top - turnRect.bottom))[0]
        ?.button || null;
    }

    isMessageSelected(record) {
      const checkboxRole = record.role === 'model' ? 'model' : 'user';
      const checkbox = record.turn?.querySelector?.(`.${CONFIG.CHECKBOX_CLASS}.${checkboxRole}`);
      return checkbox?.checked ?? true;
    }

    buildMarkdownFromSnapshots(snapshots, title) {
      let markdown = title
        ? `# ${title}\n\n`
        : '# ChatGPT Chat Export\n\n';
      markdown += `> Exported on: ${new Date().toLocaleString()}\n\n---\n\n`;

      snapshots.forEach((snapshot, index) => {
        if (snapshot.role === 'user') {
          markdown += snapshot.content
            ? `## 👤 You\n\n${snapshot.content}\n\n`
            : `## 👤 You\n\n[Could not read your message for turn ${index + 1}.]\n\n`;
        } else {
          markdown += snapshot.content
            ? `## 🤖 ChatGPT\n\n${snapshot.content}\n\n`
            : `## 🤖 ChatGPT\n\n[Could not copy the response for turn ${index + 1}.]\n\n`;
        }

        markdown += '---\n\n';
      });

      return markdown;
    }

    async export(markdown, mode, filenameBase) {
      if (mode === 'clipboard') {
        await navigator.clipboard.writeText(markdown);
        alert('Conversation copied to clipboard!');
        return;
      }

      const blob = new Blob([markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${filenameBase}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(() => {
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
      }, 1000);
    }

    async execute(mode, customFilename, selectionMode = 'all') {
      try {
        await this.scrollToLoadAll();
        this.checkboxManager.injectCheckboxes();
        if (selectionMode && selectionMode !== 'custom') {
          document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`).forEach(cb => {
            if (selectionMode === 'all') cb.checked = true;
            if (selectionMode === 'ai') cb.checked = cb.classList.contains('model');
            if (selectionMode === 'none') cb.checked = false;
          });
        }

        const snapshots = await this.collectMessageSnapshots(selectionMode);

        if (snapshots.length === 0) {
          throw new Error('Could not find any ChatGPT messages on this page.');
        }

        if (selectionMode === 'custom' && !this.checkboxManager.anyChecked()) {
          throw new Error('Messages were found, but the exporter could not classify them for selection.');
        }

        const title = this.getConversationTitle();
        const markdown = this.buildMarkdownFromSnapshots(snapshots, title);
        const filenameBase = this.generateFilename(customFilename, title);

        await this.export(markdown, mode, filenameBase);
      } finally {
        await this.restoreCopyCaptureManager();
      }
    }
  }

  // ============================================================================
  // CONTROLLER
  // ============================================================================
  class ExportController {
    constructor() {
      this.checkboxManager = new CheckboxManager();
      this.selectionManager = new SelectionManager();
      this.exportService = new ExportService(this.checkboxManager);
      this.button = null;
      this.dropdown = null;
    }

    init() {
      this.button = UIBuilder.createButton();
      this.dropdown = UIBuilder.createDropdown();
      document.body.appendChild(this.button);
      document.body.appendChild(this.dropdown);
      this.bindEvents();
      this.observeVisibility();
      this.toggleFilenameRow();
    }

    bindEvents() {
      this.button.addEventListener('click', () => this.handleButtonClick());

      this.dropdown.querySelector(`#${CONFIG.SELECT_DROPDOWN_ID}`)
        .addEventListener('change', (event) => {
          const value = event.target.value;
          this.checkboxManager.injectCheckboxes();
          this.selectionManager.apply(value);
        });

      document.addEventListener('change', (event) => {
        if (event.target?.classList?.contains(CONFIG.CHECKBOX_CLASS)) {
          const dropdown = document.getElementById(CONFIG.SELECT_DROPDOWN_ID);
          if (dropdown && dropdown.value !== 'custom') {
            dropdown.value = 'custom';
            this.selectionManager.lastSelection = 'custom';
          }
        }
      });

      document.addEventListener('mousedown', (event) => {
        if (this.dropdown.style.display !== 'none' &&
            !this.dropdown.contains(event.target) &&
            event.target !== this.button) {
          this.dropdown.style.display = 'none';
        }
      });
    }

    toggleFilenameRow() {
      const radios = this.dropdown.querySelectorAll(`input[name="${CONFIG.EXPORT_MODE_NAME}"]`);
      const filenameRow = this.dropdown.querySelector('#chatgpt-filename-row');

      const update = () => {
        const fileRadio = this.dropdown.querySelector(`input[name="${CONFIG.EXPORT_MODE_NAME}"][value="file"]`);
        if (filenameRow && fileRadio) {
          filenameRow.style.display = fileRadio.checked ? 'block' : 'none';
        }
      };

      radios.forEach(radio => radio.addEventListener('change', update));
      update();
    }

    async handleButtonClick() {
      this.checkboxManager.injectCheckboxes();
      this.selectionManager.syncWithDropdown();

      if (this.dropdown.style.display === 'none') {
        this.dropdown.style.display = '';
        return;
      }

      this.button.disabled = true;
      this.button.textContent = 'Exporting...';
      this.dropdown.style.display = 'none';

      try {
        const mode = this.dropdown.querySelector(`input[name="${CONFIG.EXPORT_MODE_NAME}"]:checked`)?.value || 'file';
        const selectionMode = this.dropdown.querySelector(`#${CONFIG.SELECT_DROPDOWN_ID}`)?.value || this.selectionManager.lastSelection;
        const filenameInput = this.dropdown.querySelector(`#${CONFIG.FILENAME_INPUT_ID}`);
        const customFilename = mode === 'file' ? filenameInput?.value?.trim() || '' : '';

        await this.exportService.execute(mode, customFilename, selectionMode);

        this.checkboxManager.removeAll();
        this.selectionManager.resetDropdown();
        if (filenameInput) filenameInput.value = '';

      } catch (error) {
        console.error('Export error:', error);
        alert(`Export failed: ${error.message}`);
      } finally {
        this.button.disabled = false;
        this.button.textContent = 'Export Chat';
      }
    }

    observeVisibility() {
      let observer = null;
      let storageDisabled = false;

      const update = () => {
        if (storageDisabled) return;

        try {
          if (chrome?.storage?.sync) {
            chrome.storage.sync.get(['hideExportBtn'], (result) => {
              this.button.style.display = result.hideExportBtn ? 'none' : '';
            });
          }
        } catch (error) {
          storageDisabled = true;
          observer?.disconnect();
          console.warn('Storage access disabled; reload the ChatGPT tab after reloading the extension.', error);
        }
      };

      update();

      observer = new MutationObserver(update);
      observer.observe(document.body, { childList: true, subtree: true });

      try {
        if (chrome?.storage?.onChanged) {
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'sync' && 'hideExportBtn' in changes) {
              update();
            }
          });
        }
      } catch (error) {
        storageDisabled = true;
        observer?.disconnect();
        console.warn('Storage change listener disabled; reload the ChatGPT tab after reloading the extension.', error);
      }
    }
  }

  // ============================================================================
  // INIT
  // ============================================================================
  const controller = new ExportController();
  controller.init();

})();

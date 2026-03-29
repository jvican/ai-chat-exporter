/**
 * Claude Chat Exporter - Content script
 * Exports Claude chats to Markdown using message markers and copy buttons.
 */

(function() {
  'use strict';

  // ============================================================================
  // CONSTANTS
  // ============================================================================
  const CONFIG = {
    BUTTON_ID: 'claude-export-btn',
    DROPDOWN_ID: 'claude-export-dropdown',
    FILENAME_INPUT_ID: 'claude-filename-input',
    SELECT_DROPDOWN_ID: 'claude-select-dropdown',
    CHECKBOX_CLASS: 'claude-export-checkbox',
    EXPORT_MODE_NAME: 'claude-export-mode',

    SELECTORS: {
      CHAT_CONTAINER_CANDIDATES: [
        'main',
        'main .overflow-y-auto',
        'div[role="log"]'
      ],
      TURN_CANDIDATES: [
        'div[data-test-render-count]'
      ],
      USER_MESSAGE: '[data-testid="user-message"]',
      ASSISTANT_CONTENT: '.standard-markdown',
      TITLE_CANDIDATES: [
        'main h1',
        'header h1',
        '[data-testid="chat-title"]',
        'title'
      ]
    },

    TIMING: {
      SCROLL_DELAY: 2000,
      MAX_SCROLL_ATTEMPTS: 60,
      MAX_STABLE_SCROLLS: 4,
      CLIPBOARD_CLEAR_DELAY: 150,
      CLIPBOARD_READ_DELAY: 300,
      MAX_CLIPBOARD_ATTEMPTS: 10,
      POPUP_DURATION: 1000,
      EXPAND_WAIT: 800
    },

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

    normalizeWhitespace(text) {
      return text.replace(/\n{3,}/g, '\n\n').trim();
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
    }
  };

  // ============================================================================
  // CHECKBOX MANAGER
  // ============================================================================
  class CheckboxManager {
    create(messageEl, type) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = `${CONFIG.CHECKBOX_CLASS} ${type}`;
      checkbox.checked = true;
      const label = type === 'user' ? 'user' : (type === 'assistant' ? 'Claude' : 'message');
      checkbox.title = `Include this ${label} message`;

      Object.assign(checkbox.style, {
        position: 'absolute',
        right: '20px',
        top: '12px',
        zIndex: '10000',
        transform: 'scale(1.1)'
      });

      if (messageEl.style.position !== 'relative') {
        messageEl.style.position = 'relative';
      }

      messageEl.appendChild(checkbox);
      return checkbox;
    }

    injectCheckboxes(messages, roleResolver) {
      messages.forEach(messageEl => {
        if (messageEl.querySelector(`.${CONFIG.CHECKBOX_CLASS}`)) return;
        const role = roleResolver(messageEl) || 'unknown';
        this.create(messageEl, role);
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
          document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}.assistant`).forEach(cb => cb.checked = true);
          break;
        case 'none':
          document.querySelectorAll(`.${CONFIG.CHECKBOX_CLASS}`).forEach(cb => cb.checked = false);
          break;
      }
      this.lastSelection = value;
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
        <div id="claude-filename-row" style="margin-top:10px;display:block;">
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
    getChatContainer() {
      for (const selector of CONFIG.SELECTORS.CHAT_CONTAINER_CANDIDATES) {
        const el = document.querySelector(selector);
        if (el) return el;
      }
      for (const selector of CONFIG.SELECTORS.TURN_CANDIDATES) {
        const firstTurn = document.querySelector(selector);
        if (firstTurn) {
          const overflowAncestor = firstTurn.closest('div.overflow-y-auto, div.flex-1, main');
          if (overflowAncestor) return overflowAncestor;
          return firstTurn.parentElement;
        }
      }
      return null;
    }

    getTurnElements() {
      let best = [];
      for (const selector of CONFIG.SELECTORS.TURN_CANDIDATES) {
        const found = Array.from(document.querySelectorAll(selector));
        if (found.length > best.length) {
          best = found;
        }
      }

      if (best.length > 0) return best;

      const container = this.getChatContainer();
      if (container?.children?.length) {
        return Array.from(container.children).filter(el => el.textContent?.trim());
      }

      return [];
    }

    findTitle() {
      for (const selector of CONFIG.SELECTORS.TITLE_CANDIDATES) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text) return text;
      }
      return document.title?.trim() || '';
    }

    async scrollToLoadAll() {
      const container = this.getChatContainer();
      if (!container) {
        throw new Error('Could not find Claude chat container. Are you on a Claude page?');
      }

      let stableScrolls = 0;
      let attempts = 0;
      let lastScrollTop = null;

      while (stableScrolls < CONFIG.TIMING.MAX_STABLE_SCROLLS && attempts < CONFIG.TIMING.MAX_SCROLL_ATTEMPTS) {
        const currentCount = this.getTurnElements().length;
        container.scrollTop = 0;
        await Utils.sleep(CONFIG.TIMING.SCROLL_DELAY);

        const newCount = this.getTurnElements().length;
        const currentTop = container.scrollTop;

        if (newCount === currentCount && (lastScrollTop === currentTop || currentTop === 0)) {
          stableScrolls++;
        } else {
          stableScrolls = 0;
        }

        lastScrollTop = currentTop;
        attempts++;
      }
    }

    async expandCollapsedContent() {
      const buttons = Array.from(document.querySelectorAll('button'));
      buttons.forEach(button => {
        const text = button.textContent?.toLowerCase() || '';
        if (text.includes('show more') || text.includes('continue') || text.includes('expand')) {
          button.click();
        }
      });
      await Utils.sleep(CONFIG.TIMING.EXPAND_WAIT);
    }

    resolveRole(messageEl) {
      // Check for user message marker
      if (messageEl.querySelector(CONFIG.SELECTORS.USER_MESSAGE)) {
        return 'user';
      }

      // Check for assistant message marker (data-is-streaming attribute)
      if (messageEl.querySelector('[data-is-streaming]')) {
        return 'assistant';
      }

      // Check if it has standard-markdown (assistant content)
      if (messageEl.querySelector(CONFIG.SELECTORS.ASSISTANT_CONTENT)) {
        return 'assistant';
      }

      // Fallback: check for copy buttons (likely assistant message with code)
      const copyButtons = messageEl.querySelectorAll('button[aria-label*="Copy"]');
      if (copyButtons.length > 0) {
        return 'assistant';
      }

      return null;
    }

    findContentElement(messageEl) {
      // Check for user message content
      const userContent = messageEl.querySelector(CONFIG.SELECTORS.USER_MESSAGE);
      if (userContent) return userContent;

      // Check for assistant message content
      const assistantContent = messageEl.querySelector(CONFIG.SELECTORS.ASSISTANT_CONTENT);
      if (assistantContent) return assistantContent;

      // Fallback to the message element itself
      return messageEl;
    }

    findCopyButton(messageEl) {
      // Look for copy buttons - prioritize message-level copy over code block copy
      const buttons = Array.from(messageEl.querySelectorAll('button[aria-label*="Copy"]'));

      // First, try to find a copy button that's not in a code block
      const nonCodeCopyButton = buttons.find(button => {
        const codeBlock = button.closest('.group\\/copy');
        return !codeBlock;
      });

      if (nonCodeCopyButton) return nonCodeCopyButton;

      // If no message-level copy button found, return null
      // (we'll use text extraction instead)
      return null;
    }

    async copyFromButton(button) {
      try {
        await navigator.clipboard.writeText('');
      } catch (e) {
        // Ignore clipboard clear errors
      }

      let attempts = 0;
      while (attempts < CONFIG.TIMING.MAX_CLIPBOARD_ATTEMPTS) {
        button.click();
        await Utils.sleep(CONFIG.TIMING.CLIPBOARD_READ_DELAY);
        const text = await navigator.clipboard.readText();
        if (text) return text;
        attempts++;
        await Utils.sleep(CONFIG.TIMING.CLIPBOARD_CLEAR_DELAY);
      }

      return '';
    }

    extractText(contentEl) {
      const clone = contentEl.cloneNode(true);
      clone.querySelectorAll('button, svg, path, script, style, noscript').forEach(el => el.remove());
      return Utils.normalizeWhitespace(clone.textContent || '');
    }

    generateFilename(custom, title) {
      const timestamp = Utils.getDateString();

      if (custom?.trim()) {
        const base = Utils.sanitizeFilename(custom.trim().replace(/\.[^/.]+$/, ''));
        return base || `claude chat export ${timestamp}`;
      }

      if (title) {
        const safe = Utils.sanitizeFilename(title);
        if (safe) return `${safe} ${timestamp}`;
      }

      return `claude chat export ${timestamp}`;
    }

    async buildMarkdown(messages, title) {
      let markdown = title
        ? `# ${title}\n\n`
        : '# Claude Chat Export\n\n';
      markdown += `> Exported on: ${new Date().toLocaleString()}\n\n---\n\n`;

      for (let i = 0; i < messages.length; i++) {
        const messageEl = messages[i];
        Utils.createNotification(`Processing message ${i + 1} of ${messages.length}...`);

        const role = this.resolveRole(messageEl);
        const checkbox = messageEl.querySelector(`.${CONFIG.CHECKBOX_CLASS}`);
        if (checkbox && !checkbox.checked) {
          continue;
        }

        const contentEl = this.findContentElement(messageEl);
        let messageText = '';

        if (role === 'assistant') {
          const copyButton = this.findCopyButton(messageEl);
          if (copyButton) {
            messageText = await this.copyFromButton(copyButton);
          }
        }

        if (!messageText) {
          messageText = this.extractText(contentEl);
        }

        if (!messageText) {
          messageText = `[Could not read message ${i + 1}.]`;
        }

        if (role === 'user') {
          markdown += `## 👤 You\n\n${messageText}\n\n`;
        } else if (role === 'assistant') {
          markdown += `## 🤖 Claude\n\n${messageText}\n\n`;
        } else {
          markdown += `## 💬 Message\n\n${messageText}\n\n`;
        }

        markdown += '---\n\n';
      }

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

    async execute(mode, customFilename, checkboxManager) {
      await this.scrollToLoadAll();
      await this.expandCollapsedContent();

      const messages = this.getTurnElements();
      if (!messages.length) {
        throw new Error('No Claude messages found. Try reloading the page.');
      }

      checkboxManager.injectCheckboxes(messages, messageEl => this.resolveRole(messageEl));
      if (!checkboxManager.anyChecked()) {
        alert('Please select at least one message to export.');
        return;
      }

      const title = this.findTitle();
      const markdown = await this.buildMarkdown(messages, title);
      const filenameBase = this.generateFilename(customFilename, title);

      await this.export(markdown, mode, filenameBase);
    }
  }

  // ============================================================================
  // CONTROLLER
  // ============================================================================
  class ExportController {
    constructor() {
      this.checkboxManager = new CheckboxManager();
      this.selectionManager = new SelectionManager();
      this.exportService = new ExportService();
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
          const messages = this.exportService.getTurnElements();
          this.checkboxManager.injectCheckboxes(messages, messageEl => this.exportService.resolveRole(messageEl));
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
      const filenameRow = this.dropdown.querySelector('#claude-filename-row');

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
      const messages = this.exportService.getTurnElements();
      this.checkboxManager.injectCheckboxes(messages, messageEl => this.exportService.resolveRole(messageEl));

      if (this.dropdown.style.display === 'none') {
        this.dropdown.style.display = '';
        return;
      }

      this.button.disabled = true;
      this.button.textContent = 'Exporting...';
      this.dropdown.style.display = 'none';

      try {
        const mode = this.dropdown.querySelector(`input[name="${CONFIG.EXPORT_MODE_NAME}"]:checked`)?.value || 'file';
        const filenameInput = this.dropdown.querySelector(`#${CONFIG.FILENAME_INPUT_ID}`);
        const customFilename = mode === 'file' ? filenameInput?.value?.trim() || '' : '';

        await this.exportService.execute(mode, customFilename, this.checkboxManager);

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
      const update = () => {
        try {
          if (chrome?.storage?.sync) {
            chrome.storage.sync.get(['hideExportBtn'], (result) => {
              this.button.style.display = result.hideExportBtn ? 'none' : '';
            });
          }
        } catch (error) {
          console.error('Storage access error:', error);
        }
      };

      update();

      const observer = new MutationObserver(update);
      observer.observe(document.body, { childList: true, subtree: true });

      if (chrome?.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'sync' && 'hideExportBtn' in changes) {
            update();
          }
        });
      }
    }
  }

  // ============================================================================
  // INIT
  // ============================================================================
  const controller = new ExportController();
  controller.init();

})();

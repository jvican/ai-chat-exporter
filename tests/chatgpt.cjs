// Run with node tests/chatgpt.cjs (requires jsdom).
const jsdom = require('jsdom');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const window = jsdom.JSDOM
  ? new jsdom.JSDOM('', { runScripts: 'outside-only' }).window
  : jsdom.jsdom('').defaultView;
const source = readFileSync('src/content_scripts/chatgpt.js', 'utf8')
  .replace('  const controller = new ExportController();\n  controller.init();',
    '  window.testAPI = { Utils, CheckboxManager, ExportService };');
window.NodeList.prototype.forEach ||= Array.prototype.forEach;
if (!window.document.body.dataset) Object.defineProperty(window.HTMLElement.prototype, 'dataset', {
  get() { return new Proxy({}, { get: (_, key) => this.getAttribute('data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())) }); }
});
window.Element.prototype.closest ||= function (selector) {
  for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
  return null;
};
window.eval(source);
const { Utils, CheckboxManager, ExportService } = window.testAPI;
const manager = new CheckboxManager();
const service = new ExportService(manager);
window.HTMLElement.prototype.scrollIntoView = function () {};
window.document.body.innerHTML = `
<div data-chatgpt-search-unit-key="fallback-turn-0:0:user" data-chatgpt-search-message-ids="user-id">
  <span title="resume.pdf">resume.pdf</span>
  <div data-user-message-bubble="true"><div class="whitespace-pre-wrap">Full prompt\nSecond line</div><button>Show more</button></div>
  <button aria-label="Copy message">Copy</button>
</div>
<div data-chatgpt-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-search-message-ids="answer-id answer-id">
  <h4 data-conversation-role="assistant">ChatGPT said:</h4>
  <div data-markdown-text-style="assistant-message">
    <h2>Preparation</h2><p>Use <span data-d-default-strong>security judgment</span>.</p>
    <ul><li><div><p>First item</p></div></li><li><p>Second item</p></li></ul>
    <table><tbody><tr><th>Action</th><th>Result</th></tr><tr><td>Read</td><td>Allow</td></tr></tbody></table>
    <div data-code-block="true"><div data-markdown-copy="exclude">Python<button>Run</button></div>
      <div class="cm-content" data-language="python"><div class="cm-line">def test():</div><div class="cm-line">    pass</div></div>
    </div>
    <div data-code-block="true"><div data-markdown-copy="exclude">Bash</div><pre><code>aws sts get-caller-identity</code></pre></div>
    <div hidden>Hidden content</div>
  </div>
</div>`;
assert.equal(Utils.getConversationTurns().length, 2);
manager.injectCheckboxes();
assert.equal(window.document.querySelectorAll('.chatgpt-export-checkbox').length, 2);
let records = service.getMessageRecords();
assert.deepEqual(Array.from(records, r => r.role), ['user', 'model']);
assert.equal(service.getMessageText(records[0].node, 'user'), 'Full prompt\nSecond line');
const markdown = service.getMessageText(records[1].node, 'model');
for (const expected of ['## Preparation', '**security judgment**', '- First item', '- Second item', '| --- | --- |', '```python\ndef test():\n    pass\n```', '```\naws sts get-caller-identity\n```']) {
  assert.ok(markdown.includes(expected), `Missing ${expected}: ${markdown}`);
}
assert.ok(!/ChatGPT said|Hidden content|Run|Bash/.test(markdown));
assert.equal(service.getMessageRecordKey(records[1]), 'model:answer-id');
assert.equal(service.getTurnNumber(records[1]), 0.000002);
assert.equal(service.findCopyButton(records[0]).getAttribute('aria-label'), 'Copy message');
assert.equal(service.shouldIncludeRecord(records[0], 'ai'), false);
records[0].turn.querySelector('input').checked = false;
assert.equal(service.isMessageSelected(records[0]), false);
// Mixed legacy/new attributes must yield one record and checkbox per turn.
window.document.body.innerHTML = `<article data-testid="conversation-turn-0" data-turn="assistant"><div data-message-author-role="assistant"><div data-chatgpt-search-unit-key="turn:0:assistant"><div class="markdown"><p>Legacy response</p></div></div></div></article>`;
manager.injectCheckboxes();
assert.equal(Utils.getConversationTurns().length, 1);
assert.equal(service.getMessageRecords().length, 1);
assert.equal(window.document.querySelectorAll('input').length, 1);
assert.equal(service.getMessageText(service.getMessageRecords()[0].node, 'model'), 'Legacy response');
// Search positions restart for every conversation turn. Preserve interleaving
// in the actual snapshot collector, including a legacy wrapper in the middle.
window.document.body.innerHTML = Array.from({ length: 3 }, (_, i) => `
  <div data-chatgpt-search-unit-key="fallback-turn-${i}:0:user"><div class="whitespace-pre-wrap">Question ${i}</div></div>
  <div data-chatgpt-search-unit-key="fallback-turn-${i}:2:assistant"><div data-markdown-text-style="assistant-message"><p>Answer ${i}</p></div></div>
`).join('');
const middleUser = window.document.querySelector('[data-chatgpt-search-unit-key="fallback-turn-1:0:user"]');
const wrapper = window.document.createElement('article');
wrapper.setAttribute('data-testid', 'conversation-turn-1');
middleUser.parentNode.replaceChild(wrapper, middleUser);
wrapper.appendChild(middleUser);
Utils.sleep = async () => {};
service.collectMessageSnapshots().then(snapshots => {
  assert.deepEqual(Array.from(snapshots, snapshot => snapshot.content), [
    'Question 0', 'Answer 0', 'Question 1', 'Answer 1', 'Question 2', 'Answer 2'
  ]);
  const output = service.buildMarkdownFromSnapshots(snapshots, 'Test');
  assert.ok(output.indexOf('Answer 0') < output.indexOf('Question 1'));
  console.log('ChatGPT DOM regression checks passed');
}).catch(error => { console.error(error); process.exitCode = 1; });

# Playwright page script

`playwright-injected.js` contains the generated injected-script source already installed by the repository's pinned `playwright-core` 1.63.0 dependency. It is extracted from the `packages/playwright-core/src/generated/injectedScriptSource.ts` section in `node_modules/playwright-core/lib/coreBundle.js`, without changing that dependency or importing Playwright's input dispatcher. The original Apache-2.0 license is preserved in `LICENSE.playwright`.

The extension evaluates this fixed source only through CDP in isolated page contexts. Locator, actionability and aria helpers use this implementation; actual input stays in the existing generation-guarded driver. No tool accepts an evaluation expression, page script or arbitrary selector.

The injected API is internal and pinned. When changing the Playwright version, regenerate this source, inspect the constructor and utility API, rerun the targeted tests, and complete Chrome acceptance. A syntax check or fake-CDP test does not prove real Chrome compatibility.

## Real Chrome regression test (1029)

Any change under `browser-extension/` must pass the real-browser test, which runs the extension's own driver code in a real headless Chrome (fresh temporary profile, local test pages only, no network, no extension install):

```
node --test --test-concurrency=1 --test-reporter=dot tests/v1/1029-helper-real-chrome.test.mjs
```

Chrome is found at `CHATHAND_TEST_CHROME`, then `/Applications/Google Chrome.app`, then Playwright's Chromium under `/opt/pw-browsers`; without one the test is skipped and says so. `tests/support/real-chrome.mjs` builds the `chrome.*` APIs the driver uses (tabs, tab groups, debugger with flat child sessions for cross-origin iframes) on top of a CDP pipe. The referenced test includes a local ChatGPT plugins-page fixture.

改 `browser-extension/` 必须跑上面这个真浏览器测试；Mac 上用真的 Google Chrome，云端用 /opt/pw-browsers 里的 Chromium。

Sources: [Playwright repository](https://github.com/microsoft/playwright), [actionability](https://playwright.dev/docs/actionability), [Chrome debugger flat sessions](https://developer.chrome.com/docs/extensions/reference/api/debugger#attach-to-related-targets).

# Tests

`layout.json` declares the Node suites and maps historical test roots to their current locations. Its `additional_files` entries preserve the executable tests in `v1/setup-test.mjs` and `v1/support.mjs`, whose historical names lack the `.test.mjs` suffix. `npm test` and `npm run test:trial` use the same discovery code. `npm run test:list` lists every selected test without executing it.

| Suite | Location |
| --- | --- |
| `core`, `product`, `release`, `stability` | Corresponding directories under `tests/` |
| `v06`, `v07`, `v08`, `v09`, `v1` | Versioned regression suites under `tests/` |
| `relay` | `tests/v1/relay-v412/` |
| `engine`, `native`, `scripts` | Tests kept beside their owning component |
| `skin-studio`, `development` | Explicit development-only distributions |

Shared helpers and native source fixtures live in `tests/support/` and beside the suites that use them. Browser UI checks live in `tests/ui/` and run separately with `npm run test:ui`; see [their guide](ui/README.md).

```sh
# Discover files; a missing or empty required suite is an error.
npm run test:list

# Run one or more declared suites.
node scripts/test-node.mjs --suite core,release

# Run one file using Node directly.
node --test tests/v1/1065-setup-consent.test.mjs
```

Use the same Node version, dependency lock, and explicit fixture inputs when comparing a change with its base. Chrome checks use `CHATHAND_TEST_CHROME` or the documented local browser discovery. Tests that compile or execute native helpers require macOS and the Xcode command-line tools. Signed-App and prepared-native-fixture checks require their explicit inputs; consult the test's failure message and fixture setup before running those suites.

Run integration checks with isolated state, temporary directories, and a test browser profile. Review subprocesses and fixture paths before execution. Protect the installed App, user files, credentials, clipboard, and existing browser sessions. Test completion and a successful source build are separate from installing the App or verifying a live ChatGPT connection.

The public export excludes development-only checks and private Worker consumers. `layout.json` identifies optional distributions explicitly; a present but incomplete distribution fails discovery. Historical baseline files retain their original bytes and paths. Comparators apply the one-to-one `root_aliases` mapping to file identities while preserving test names and diagnostics.

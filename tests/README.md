# Tests

`layout.json` declares the Node suites, historical entry-point scopes, and the mapping from old test roots to current locations. `npm run test:list` lists the default entry point without executing tests.

The existing commands retain their original scope. `npm test` runs the declared component and version suites, including nested relay tests. `npm run test:v1` selects the top-level v1 test files. `npm run test:trial` selects the engine and former top-level test directories, including every top-level v1 `.mjs` module. That preserves the executable tests in `v1/setup-test.mjs` and `v1/support.mjs`, whose historical names lack the `.test.mjs` suffix. Each v1 entry point also retains the internal documentation assertions moved into `development/installation-docs.test.mjs` when that development distribution is present.

`npm run test:layout` runs the new discovery, entry-point, and historical-result checks separately. `npm run test:all` selects every declared suite and the two additional executable v1 test files. Append `-- --list` to either command to inspect its files.

| Suite | Location |
| --- | --- |
| `core`, `product`, `release`, `stability` | Corresponding directories under `tests/` |
| `v06`, `v07`, `v08`, `v09`, `v1` | Versioned regression suites under `tests/` |
| `relay` | `tests/v1/relay-v412/` |
| `engine`, `native`, `scripts` | Tests kept beside their owning component |
| `skin-studio`, `development` | Explicit development-only distributions |
| `layout` | Discovery and entry-point regression checks in `tests/layout/` |

Shared helpers and native source fixtures live in `tests/support/` and beside the suites that use them. Browser UI checks live in `tests/ui/` and run separately with `npm run test:ui`; see [their guide](ui/README.md).

```sh
# Discover files; a missing or empty required suite is an error.
npm run test:list
npm run test:trial -- --list
npm run test:all -- --list

# Run one or more declared suites.
node scripts/test-node.mjs --suite core,release

# Check the source layout and entry-point contracts.
npm run test:layout

# Run one file using Node directly.
node --test tests/v1/1065-setup-consent.test.mjs
```

Use the same Node version, dependency lock, and explicit fixture inputs when comparing a change with its base. Chrome checks use `CHATHAND_TEST_CHROME` or the documented local browser discovery. Tests that compile or execute native helpers require macOS and the Xcode command-line tools. Signed-App and prepared-native-fixture checks require their explicit inputs; consult the test's failure message and fixture setup before running those suites.

Run integration checks with isolated state, temporary directories, and a test browser profile. Review subprocesses and fixture paths before execution. Protect the installed App, user files, credentials, clipboard, and existing browser sessions. Test completion and a successful source build are separate from installing the App or verifying a live ChatGPT connection.

The public export excludes development-only checks and private Worker consumers. `layout.json` identifies optional distributions explicitly; a present but incomplete distribution fails discovery. Historical baseline files retain their original bytes and paths. Comparators apply the one-to-one `root_aliases` mapping to file identities while preserving test names and diagnostics.

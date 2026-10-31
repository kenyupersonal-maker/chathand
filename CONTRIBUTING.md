# Working with the source

ChatHand is a macOS app with a local Node service, a Chrome extension, and a pinned Site template. The public repository contains a reviewed source export. Product development and release preparation happen in the development repository; public source updates retain the export's provenance.

## Repository map

| Directory | Purpose |
| --- | --- |
| `app/`, `engine/` | Local service, tool execution, and runtime modules |
| `native/` | macOS shell and native helpers |
| `ui/`, `locales/` | App pages, assets, and Chinese/English resources |
| `browser-extension/` | Chrome extension and its vendored runtime |
| `connectors/`, `cloud/`, `contracts/` | Connection code and protocol contracts |
| `skills/`, `plugins/`, `codex/` | Integration packages and setup guidance |
| `site-template/` | Pinned template archives and supporting source |
| `scripts/` | Build, verification, packaging, and source-export tools |
| `tests/` | Shared regression suites, fixtures, and browser UI checks |
| `vendor/`, `licenses/` | Vendored dependencies and license material |

Versioned paths such as `app/v06/` through `app/v09/`, `ui/h10/`, and `scripts/build-v09.mjs` still have active callers. Their names are compatibility boundaries. Inspect imports, packaging, and runtime use before moving them.

## Local checks

Use Node 22 or later and the versions pinned in `package-lock.json`. Install those dependencies with `npm ci` in your source checkout. Inspect the declared test suites before running them:

```sh
npm run test:list
node scripts/test-node.mjs --suite core
npm run test:v1
npm run test:layout
npm test
```

The runner reports the discovered file count and fails if a required suite is missing or empty. Existing commands keep their historical scope: `test:v1` selects top-level v1 tests; `test:trial` retains the engine and former top-level test suites, including v1 modules with nonstandard test filenames. `test:layout` runs the new source-layout checks, and `test:all` runs all declared suites. Development-only checks are explicitly declared and reported when absent from a public export. The browser UI suite has its own entry point:

```sh
npm run test:ui
```

See [tests/README.md](tests/README.md) for prerequisites and focused commands. Some checks need macOS, Chrome, compiled native fixtures, or a signed candidate App. Run those in an isolated development environment with explicit fixture paths. An unavailable fixture, a skipped test, or a sandbox incompatibility must remain visible in the result.

## Source builds

Building the App requires an Apple Silicon Mac and the Xcode command-line tools. An unsigned development build uses fresh output, compiler-cache, and tunnel-cache directories outside the checkout:

```sh
node scripts/build-v09.mjs --unsigned --isolated-unsigned \
  --isolation-root /absolute/path/to/new-build \
  --tunnel-cache /absolute/path/to/new-build/tunnel-cache \
  --output /absolute/path/to/new-build/ChatHand.app
```

The source must be a clean Git checkout. The build uses the locked runtime dependencies and downloads the pinned tunnel runtime into the specified cache. The output is a development artifact; installation, signing, updates, system permissions, and live connection acceptance have separate checks.

## Changes and reports

Keep product behavior and build numbers unchanged for source-only maintenance. Include the operating system, commands, fixture versions, and any failures or unexecuted checks in a change report. Compare regressions with the same base revision and environment, and preserve historical evidence when paths change. Do not include credentials, user profiles, private development history, or local audit files in a public source contribution.

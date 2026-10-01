# SaySpec

A fast natural-language browser testing CLI. Playwright observes the current page as a compact table of visible, actionable elements. A Jev decision model or a general-purpose LLM chooses a typed status, operation, and element from that table. The executor accepts only those observed choices—never model-generated selectors, coordinates, JavaScript, or shell commands.

This is an early working foundation, not yet a production test framework. It follows the architecture described by [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast): one Jev request can speculatively answer the step-status, operation, and compatible target questions; only the target belonging to the selected operation is allowed to execute.

## Why Playwright

Playwright is the best fit for an agentic CLI: it supports isolated contexts, Chromium/Firefox/WebKit, deterministic input, frames, shadow DOM locators, downloads, screenshots, and headless or visible execution without requiring the application to load a test runtime. Cypress remains excellent for authored frontend tests, while Selenium adds driver and synchronization overhead that does not help this indexed-action design.

## Install

```sh
npm install
npx playwright install chromium
cp .env.example .env
```

Jev is the default classifier; set `TYPESAFE_API_KEY` to use it. To classify with a general-purpose model instead, configure one of the providers below and pass `--llm`. When no dedicated `TEXT_MODEL_*` configuration is present, the OpenAI configuration is also used to generate field values.

```sh
# OpenAI (auto-detected first when multiple providers have keys)
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5-mini
OPENAI_REASONING=low
sayspec suite.yaml --llm

# Anthropic (fast default: claude-haiku-4-5)
ANTHROPIC_API_KEY=...
sayspec suite.yaml --llm --llm-provider anthropic

# Ollama through its OpenAI-compatible chat endpoint
OLLAMA_MODEL=<your-local-chat-model>
sayspec suite.yaml --llm --llm-provider ollama
```

Use `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_REASONING` for provider-neutral configuration. `LLM_BASE_URL` takes precedence over provider-specific URLs, so an OpenAI-compatible deployment can be selected with, for example, `LLM_PROVIDER=openai` and `LLM_BASE_URL=http://localhost:8000/v1`. The equivalent CLI overrides are `--llm-provider`, `--llm-base-url`, `--llm-model`, and `--llm-reasoning`.

OpenAI and Anthropic requests use strict JSON Schema output with one enum per decision. Ollama uses the same OpenAI-compatible request shape. Returned keys are still checked against the currently offered operations and observed elements before any browser action executes.

Install the CLI from this checkout and use it from any directory:

```sh
npm run build
npm install -g .

sayspec /absolute/path/to/suite.yaml
ss /absolute/path/to/suite.yaml
```

Once published, the equivalent installation is `npm install -g sayspec`. Running either command without a path searches the current directory and its parents for `sayspec.yaml`, `sayspec.yml`, `sayspec.json`, `.sayspec.yaml`, or `.sayspec.yml`. `sayspec --init` creates a starter suite.

Useful options:

```text
--headed                    Show the browser
--browser chromium|firefox|webkit|brave
--cdp <url>                 Attach to a remote-debugging Brave/Chromium
--executable-path <path>    Override browser executable discovery
--user-data-dir <path>      Use a persistent automation profile
--artifacts always|failure|off
--artifact-root <directory>
--workers <count>           Run dependency-ready tests concurrently (1-64)
--json <result-file>
--jev                       Use Jev (default)
--llm                       Use an auto-detected LLM provider
--llm-provider <provider>   openai, anthropic, or ollama
--llm-base-url <url>        Override the API base URL/local host
--llm-model <model>         Override the classifier model
--llm-reasoning <level>     Override reasoning effort
```

## Spec format

```yaml
name: Store smoke tests
baseUrl: https://shop.example.com
artifacts: failure
gif: true
workers: 4

tests:
  - id: login
    steps:
      - do: Enter the test account email
        inputEnv: TEST_EMAIL
        sensitive: true
      - do: Enter the test account password
        inputEnv: TEST_PASSWORD
        sensitive: true
      - Click Sign in
    assertions:
      - expect: The account menu shows the test account is signed in
        timing: end

  - id: checkout
    dependsOn: [login]
    goal: Verify an in-stock item can reach checkout
    steps:
      - Search for the blue travel mug
      - do: Add the blue travel mug to the cart
        when: The item is visibly in stock
        expect: The cart contains one blue travel mug
      - Open the cart
    assertions:
      - expect: No visible error or failure message is present
        timing: throughout
      - expect: The cart total and checkout button are visible
        timing: end
    cleanup:
      - do: Remove the blue travel mug from the cart
        when: The cart contains the blue travel mug

  - id: order-history
    dependsOn: [login]
    url: /orders
    steps:
      - Verify the latest order is visible
```

Steps may be strings or objects with `do`, `when`, `expect`, and `maxActions`. Dependencies are topologically ordered; a test is skipped when a dependency fails or is skipped. Cleanup runs in `finally`, including after step or assertion failures.

Ordinary suites run each test in a fresh browser context. After a test passes, its cookies, local storage, and IndexedDB state are captured in memory. A test with one dependency starts with that dependency's state, so `login` runs once while `checkout` and `order-history` receive separate authenticated contexts and can run in parallel. The state is not written to the artifact directory or another file.

`workers` defaults to `1` and can be overridden with `--workers`. Tests run as soon as all their dependencies have completed successfully, up to the worker limit. Each parallel test gets its own browser context, so changes made by one sibling do not leak into another.

When a test has multiple dependencies, use `stateFrom` to select the direct dependency whose browser state it should inherit; status still depends on every listed test:

```yaml
- id: combined-check
  dependsOn: [login, seeded-data]
  stateFrom: login
  steps:
    - Verify the combined scenario
```

`--cdp` and `userDataDir` intentionally retain a shared persistent context and require one worker. Persistent browser profiles cannot safely be opened by parallel workers.

Use `input` when a step has known test data and you do not want a text-model call:

```yaml
- do: Search for a USB-C cable
  input: usb c cable
  expect: USB-C cable results are visible
```

Jev still decides whether typing is needed and which observed field receives the value. It cannot turn `input` into a selector or executable instruction.

For secrets, use `inputEnv` and optionally `sensitive: true`; the value is read only at execution time and redacted from the trace:

```yaml
- do: Enter the test account password
  inputEnv: TEST_PASSWORD
  sensitive: true
```

For local use, put these variables in the ignored `.env` file. In CI, inject them from the CI provider's secret store. Saved browser state contains live session credentials and is therefore kept in memory only. Failure screenshots can still contain sensitive page content, so use a dedicated low-privilege test account and choose the artifact policy accordingly.

Uploads require an explicit `files` list in the step. Paths resolve relative to the spec file, and Jev receives only the fact that authorized files are available—not their paths.

`throughout` assertions run before the first step and after every browser action. `end` assertions run after all steps. Assertions and conditional skips are Jev judgments over the current visible UI—not string matching against the full DOM.

## Artifacts

Each retained test artifact directory contains ordered PNG screenshots and a redacted JSON action trace. If `ffmpeg` is on `PATH` (or `FFMPEG_PATH` points to it), screenshots are compiled into `run.gif`. With `artifacts: failure`, passing test artifacts are discarded and failures retain the final screenshot and GIF. Screenshot capture is intentionally outside the decision loop: images are evidence, not model input.

## Safety and robustness boundaries

- Every model-selected target must be a current indexed element and support the selected operation.
- The executor rechecks uniqueness, visibility, enabled state, and a semantic signature immediately before input.
- Password and one-time-code values are redacted from observations and traces.
- Jev response choices, probability keys, ranges, sums, argmax, and confidence thresholds are validated.
- Page text is explicitly treated as untrusted data in every Jev/text-model instruction.
- A failed cleanup is reported and cannot turn a failed test into a pass.

The action layer supports click, double-click, right-click, hover, typing, native dropdown selection, check/uncheck, authorized file uploads, drag/drop, allowlisted keys and shortcuts, nested vertical scrolling, back/forward/reload, popup/tab switching, and guarded tab closing. Current limitations are closed shadow roots, canvas-only controls, browser-chrome shortcuts, highly virtualized or horizontal scroll regions, downloads that require post-download file assertions, and visual-only assertions. Open shadow roots and ordinary frames are supported. A `COMPLETE` result is still a semantic model judgment; important business outcomes should eventually support optional deterministic validators (URL, API, database, or domain-specific checks) alongside Jev.

### Brave

`browser: brave` discovers the standard Brave executable on macOS, Windows, and Linux. To attach to an already running automation-enabled Brave instance:

```sh
/Applications/Brave\ Browser.app/Contents/MacOS/Brave\ Browser \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.sayspec/brave-profile"

sayspec suite.yaml --cdp http://127.0.0.1:9222
```

Chromium requires a non-default user-data directory for remote debugging. SaySpec creates and later closes only its own tab when attached; it does not shut down the connected browser.

## Conformance and live examples

The local fixture exercises typing, clicking, native selection, a nested scroll region, Enter, back navigation, popups, and tab switching:

```sh
# terminal 1
npm run fixture

# terminal 2
npm run dev -- examples/conformance.yaml
# or, after global installation:
sayspec examples/conformance.yaml
```

`npm run test:live-jev` makes a small set of real Jev API calls against synthetic browser states. `npm run test:live-llm` runs the same classifier checks with the auto-detected LLM provider. Both verify click, type, select, nested scroll, keyboard, back, and tab-switch decisions.

Best-effort public-site journeys live under `examples/live/`:

- `wikipedia.yaml` covers search, navigation, page scrolling, and back.
- `github.yaml` covers site search, Enter, navigation, and scrolling.
- `amazon-cart.yaml` covers search, result scrolling, product navigation, quantity selection, cart mutation, verification, and cleanup. It never checks out or places an order.

Public examples should not be treated as deterministic CI fixtures. Consent screens, A/B tests, localization, bot challenges, inventory, and site redesigns can legitimately block them. The local conformance suite is the stable regression target; public journeys are compatibility probes with failure screenshots and GIFs.

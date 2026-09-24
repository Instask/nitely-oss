# Issue 420: Native Visual DevTools provider contract spike

Date: 2026-07-23

## Decision

Do not implement production iOS Simulator or Android Emulator providers in this
issue. Keep the current Playwright Chromium provider as the only production
preview runtime until native hosts can pass explicit preflight checks.

The shared contract is viable only if native providers advertise narrower,
platform-specific capabilities instead of pretending to match Playwright. The
next implementation slices should add iOS and Android providers behind host
preflight, typed capability negotiation, and structured unsupported/prerequisite
errors.

## POC result

The minimum native POC is blocked by reproducible host-prerequisite failures in
the available environments. No device state was modified.

### Local macOS host

```text
$ xcode-select -p
exit 0
/Applications/Xcode.app/Contents/Developer

$ xcrun --find simctl
exit 0
/Applications/Xcode.app/Contents/Developer/usr/bin/simctl

$ xcrun simctl list runtimes
TIMEOUT after 5s

$ xcrun simctl list devices available
TIMEOUT after 5s

$ xcrun simctl help
TIMEOUT after 5s

$ xcrun simctl io help
TIMEOUT after 5s

$ adb devices
MISSING executable

$ emulator -list-avds
MISSING executable
```

Interpretation: Xcode and `simctl` resolve, but simulator inventory and help
commands do not complete within a bounded probe. That means Nitely cannot safely
select a simulator, validate a runtime, or launch an app on this host without a
separate Xcode/Simulator remediation step.

Android tooling is not installed on the local host path, so no emulator/device
inventory can be produced.

### Remote Linux deployment host

```text
$ uname -a
Linux instask-home-server-01 6.17.0-14-generic #14~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Thu Jan 15 15:52:10 UTC 2 x86_64 x86_64 x86_64 GNU/Linux

$ command -v xcrun
MISSING

$ command -v adb
MISSING

$ command -v emulator
MISSING
```

Interpretation: the production/development Linux host is not a valid native
preview host today. It can continue serving the Web preview runtime, but native
provider POCs must run on a prepared macOS/Xcode host for iOS and an Android SDK
host with emulator acceleration for Android.

## Source notes

Primary source checks used for the contract:

- Apple Simulator documentation confirms command-line simulator screenshots via
  `xcrun simctl io booted screenshot` and points users to `xcrun simctl help`
  and `xcrun simctl io help`. The page is an archived/deprecated Xcode 9-era
  document, so it is useful evidence for screenshot support but not sufficient
  as a complete modern provider contract:
  <https://developer.apple.com/library/archive/documentation/IDEs/Conceptual/iOS_Simulator_Guide/InteractingwiththeiOSSimulator/InteractingwiththeiOSSimulator.html>
- Context7/Android Developers and the Android adb docs describe `adb` as the
  Android SDK Platform-Tools command for communicating with devices/emulators,
  installing/debugging apps, and running device shell commands:
  <https://developer.android.com/tools/adb>
- Android SDK Platform-Tools include `adb` and are the required command-line
  package for direct device/emulator control:
  <https://developer.android.com/tools/releases/platform-tools>
- Android Emulator documentation defines the command-line emulator entry point,
  `emulator @avd_name`, `emulator -avd avd_name`, and AVD discovery through
  `emulator -list-avds`:
  <https://developer.android.com/studio/run/emulator-commandline>
- Android UI Automator APIs provide reliable in-app/system UI element lookup and
  interaction primitives, but require an instrumentation/testing runtime rather
  than a pure process-local CLI contract:
  <https://developer.android.com/training/testing/other-components/ui-automator>

## Capability matrix

Legend:

- Ready: production-supported by the current Playwright provider.
- Feasible: official tooling exists, but Nitely still needs implementation and
  host preflight.
- Partial: feasible only with narrower semantics or extra framework/tooling.
- Blocked: unavailable in the current host probe.
- Unsupported: should not be represented as a supported capability.

| Capability | Playwright Chromium | iOS Simulator | Android Emulator | Contract implication |
| --- | --- | --- | --- | --- |
| Host preflight | Ready: Node + Playwright executable resolution at runtime | Blocked on this host: Xcode path and `simctl` resolve, but `simctl list/help` time out | Blocked on local and remote hosts: `adb` and `emulator` missing | Add a provider preflight phase before sessions can be started. |
| Device/runtime discovery | Not applicable beyond viewport presets | Feasible through `simctl list`, but blocked by current timeout | Feasible through `emulator -list-avds` and `adb devices`, but tools missing | Discovery must return typed unavailable/prerequisite errors, not empty success. |
| Lifecycle start/stop | Ready: repository command process + Chromium runtime | Feasible through simulator boot/shutdown/bootstatus once `simctl` is healthy | Feasible through `emulator @AVD`, `adb wait-for-device`, and process ownership | Track whether Nitely booted the device before attempting shutdown. |
| App build | Ready for web dev server command | Requires repo command producing a Simulator `.app` bundle | Requires repo command producing an APK or installable bundle output | Native config needs explicit build output paths and package identifiers. |
| Install/launch | Not needed; web session navigates to loopback URL | Feasible with Simulator app bundle + bundle id, but not validated on this host | Feasible with `adb install` and package/activity launch, but not validated here | Install and launch are native-specific capabilities, not web navigation. |
| Navigation/reload | Ready: same-origin URL navigation and page reload | Partial: can launch/open app or deep link; no browser-like arbitrary URL reload for all apps | Partial: can launch activity/deep link or force-stop/restart; no universal page reload | Split `navigate` from `launch`, `open_deeplink`, and `restart_app`. |
| Screenshot | Ready: PNG viewport/full-page screenshot | Feasible for screen PNG through `simctl io booted screenshot`; full-page is unsupported | Feasible screen PNG through adb/UI tooling after device connection; full-page is unsupported | Native screenshot capability should be screen-only and may include device chrome/status bars. |
| Visual diff artifacts | Ready through #418/#419 artifact pipeline | Feasible once screenshots produce bounded PNG artifacts | Feasible once screenshots produce bounded PNG artifacts | Reuse visual-diff artifact schema; do not return raw image bytes through tools. |
| Console/log diagnostics | Ready: console, page errors, failed requests, server tails | Partial: app/system logs need host log collection predicates and redaction | Partial: `adb logcat`/bugreport-style diagnostics need filtering and redaction | Native logs require separate retention, filtering, and secret handling. |
| Crash detection | Ready for browser page errors/server exit, not native crashes | Partial: needs simulator/device crash log collection and app bundle matching | Partial: needs logcat/tombstone/bugreport parsing and package matching | Expose as `crash_diagnostics`, not as generic Playwright `pageErrors`. |
| View hierarchy | Ready: DOM/layout/computed style | Unsupported with `simctl` alone; requires XCTest/XCUITest, accessibility, or WebDriverAgent-like tooling | Partial through UI Automator/instrumentation; CLI-only hierarchy should be probe-gated | Hierarchy shape must carry provider-specific node types and confidence. |
| Click/type/scroll actions | Ready: Playwright locator actions | Unsupported with `simctl` alone for semantic selectors; possible with XCTest/accessibility tooling | Partial with UI Automator selectors or coordinate-based adb input | Actions must declare selector dialect and whether they are semantic or coordinate-based. |
| Device switching | Ready through viewport presets, not real devices | Feasible only after simulator inventory and UDID/runtime selection | Feasible only after AVD/device serial selection | Require explicit device selector and reject ambiguous device sets. |
| Cleanup/stale recovery | Ready: process handle, runtime close, stale sessions on Nitely restart | Requires ownership-aware shutdown and stale boot/install cleanup | Requires owned emulator PID/serial tracking and stale adb/emulator cleanup | Persist ownership metadata, not just provider name. |
| Concurrent sessions | Ready within process/resource limits | Risky: shared Simulator service and device locks | Risky: emulator CPU/RAM/port contention and adb server sharing | Default max native sessions should be 1 per repo/device until proven safe. |

## Provider capability negotiation

The current `PreviewProviderCapabilities` shape is enough for Playwright but too
coarse for native providers. Native support should extend discovery with:

```ts
type PreviewCapabilityStatus =
  | "ready"
  | "probe_required"
  | "unsupported"
  | "host_prerequisite_missing"
  | "device_unavailable";

interface PreviewCapabilityDescriptor {
  name: string;
  status: PreviewCapabilityStatus;
  selectorDialect?: "css" | "accessibility" | "uiautomator" | "coordinate";
  artifactTypes?: Array<"image/png" | "text/plain" | "application/json">;
  limitations?: string[];
  prerequisite?: string;
}
```

Provider discovery should return both host status and session-action status:

- `provider`: stable id such as `playwright-chromium`, `ios-simulator`, or
  `android-emulator`.
- `host`: OS, tool paths, tool versions where available, and bounded preflight
  result.
- `devices`: discovered simulator/emulator records, or a typed unavailable
  result.
- `capabilities`: per-action descriptors. Unsupported actions are explicit.
- `limits`: max sessions, startup timeout, install timeout, screenshot timeout,
  log tail limits, and artifact size limits.

MCP and HTTP tools should reject unsupported operations before touching host
state. Capability presence must be checked at call time because native devices
can become stale or disappear between discovery and action.

## Error semantics

Use structured provider errors with stable `code`, human `message`, and optional
`details` safe for audit logs:

- `unsupported_capability`: the provider does not implement the requested action.
- `host_prerequisite_missing`: required tool, runtime, license, acceleration, or
  permission is absent.
- `host_probe_timeout`: a bounded preflight command did not return.
- `device_unavailable`: the selected simulator/emulator is missing, offline, or
  not bootable.
- `ambiguous_device`: multiple devices match and the config did not select one.
- `app_build_failed`: repository build command failed.
- `app_artifact_missing`: build finished but the `.app`/APK output is absent.
- `app_install_failed`: install returned a non-zero exit or timed out.
- `app_launch_failed`: bundle/package/activity launch failed or readiness failed.
- `app_not_visible`: screenshot/hierarchy/action target does not match the
  expected app.
- `permission_denied`: Xcode, adb, OS privacy, license, or debug trust gate
  blocked control.
- `timeout`: an action exceeded its configured bound.
- `stale_session`: Nitely restarted or lost the owned process/device handle.
- `artifact_rejected`: screenshot/log output exceeded size, path, integrity, or
  redaction policy.

Errors must not include raw logs by default. They can include references to
bounded artifacts after redaction.

## Native repository configuration

Do not overload the current Web command shape with native-specific fields.
Introduce an additive `targets` section in a future schema revision while keeping
the existing Web config valid:

```json
{
  "schemaVersion": "nitely.preview.v2",
  "targets": [
    {
      "id": "ios-simulator",
      "provider": "ios-simulator",
      "build": {
        "command": "xcodebuild",
        "args": [
          "-scheme",
          "App",
          "-sdk",
          "iphonesimulator",
          "-configuration",
          "Debug",
          "build"
        ],
        "cwd": ".",
        "outputPath": "build/Debug-iphonesimulator/App.app"
      },
      "app": {
        "bundleId": "com.example.App",
        "launchArgs": [],
        "launchEnv": {}
      },
      "device": {
        "name": "iPhone 16",
        "runtime": "iOS 26",
        "udid": null
      },
      "readiness": {
        "timeoutMs": 60000,
        "logPredicate": "process == \"App\""
      }
    }
  ]
}
```

```json
{
  "schemaVersion": "nitely.preview.v2",
  "targets": [
    {
      "id": "android-emulator",
      "provider": "android-emulator",
      "sdk": {
        "androidHomeEnv": "ANDROID_HOME",
        "platformToolsPath": null,
        "emulatorPath": null
      },
      "build": {
        "command": "./gradlew",
        "args": [":app:assembleDebug"],
        "cwd": ".",
        "outputPath": "app/build/outputs/apk/debug/app-debug.apk"
      },
      "app": {
        "packageName": "com.example.app",
        "activity": ".MainActivity",
        "launchIntent": null,
        "permissions": []
      },
      "device": {
        "avdName": "Pixel8_API_34",
        "serial": null,
        "dataDir": null
      },
      "readiness": {
        "timeoutMs": 90000,
        "logcatRegex": "Displayed com.example.app"
      }
    }
  ]
}
```

Framework-neutral required fields:

- target id and provider id;
- build command, args, cwd, inherited/env variables, and output path;
- app identifier (`bundleId` or `packageName`) and launch entry point;
- device selector;
- bounded readiness timeout;
- cleanup policy.

Platform-specific unavoidable fields:

- iOS: Xcode developer directory, simulator runtime/name/UDID, `.app` path,
  bundle id, launch args/env, optional log predicate.
- Android: SDK/platform-tools/emulator paths, AVD name or adb serial, APK path,
  package/activity/deep link or intent, permissions, optional logcat readiness
  regex.

## Cleanup and stale recovery

Native sessions should use an ownership model:

- If Nitely starts a simulator/emulator, persist owned process/device metadata
  and clean it up on normal stop.
- If Nitely attaches to an already-running device, do not shut it down unless the
  config explicitly allows takeover.
- Bound boot, install, launch, screenshot, hierarchy, action, and stop phases
  independently.
- Persist `starting`, `ready`, and `stopping` sessions as `stale` after Nitely
  restart, then require explicit recovery or replacement.
- Use per-repo/per-device locks. Default native concurrency should be one owned
  session per device.
- For Android, avoid shared mutable AVD state when possible by requiring a
  dedicated AVD or configured data directory for automated runs.
- For iOS, do not erase simulator content automatically unless the config opts
  into destructive reset.

## Artifact and redaction policy

Native screenshots and diagnostics can become evidence only through the existing
artifact path/integrity model:

- write artifacts under the repository/run-owned `.nitely` tree;
- return metadata, hashes, size, MIME type, capture timestamp, provider, device,
  and app identifiers;
- do not return raw screenshot bytes through MCP/API tool responses;
- redact configured secrets from stdout/stderr/log tails before persistence;
- treat screenshots as potentially sensitive because UI may include credentials,
  personal data, notifications, or customer content;
- cap log tails and crash reports; persist full raw diagnostics only behind a
  separate high-impact export action.

## Security boundaries

Native providers expand the trust boundary beyond a local web dev server:

- `preview:read` can expose screenshots, view hierarchy, logs, and crash
  metadata.
- `preview:control` can mutate app/device state by launching apps, granting
  permissions, tapping controls, entering text, and changing stored data.
- Host prerequisites may require Xcode license acceptance, simulator runtimes,
  Android SDK installation, hardware acceleration, adb debug authorization, and
  OS-level privacy/trust prompts.
- Physical devices remain out of scope. The provider must reject physical-device
  serials unless a separate issue changes this boundary.
- Repository config must not allow arbitrary host paths, unbounded commands, or
  implicit access to secrets beyond the existing explicit env allowlist model.

## Recommended follow-up issues

### Implement iOS Simulator preview provider behind host preflight

Estimate: 3-5 engineering days after a healthy macOS/Xcode runner is available.

Acceptance:

- Add `ios-simulator` provider discovery with bounded `xcode-select`, `xcrun`,
  simulator runtime, and device inventory checks.
- Support build/install/launch/screenshot/stop for one configured Simulator
  `.app` and bundle id.
- Advertise unsupported hierarchy/actions unless an explicit XCTest/accessibility
  adapter is included.
- Persist screenshot artifacts through the existing preview evidence pipeline.
- Add tests with fake `simctl` adapters for success, timeout, missing runtime,
  stale session, and cleanup.
- Do not support physical devices.

### Implement Android Emulator preview provider behind SDK/AVD preflight

Estimate: 4-6 engineering days after an Android SDK/emulator runner is
available.

Acceptance:

- Add `android-emulator` provider discovery with bounded `ANDROID_HOME`,
  platform-tools, emulator binary, AVD inventory, and `adb devices` checks.
- Support build/install/launch/screenshot/stop for one configured APK,
  package/activity, and AVD.
- Add screen-only PNG artifacts and bounded logcat diagnostics with redaction.
- Advertise UI hierarchy/actions only after a UI Automator or coordinate-action
  adapter is implemented and selector semantics are documented.
- Add tests with fake adb/emulator adapters for success, missing tools, ambiguous
  devices, offline devices, timeout, stale session, and cleanup.
- Do not support physical devices.

### Add provider-contract tests for non-Playwright runtimes

Estimate: 1-2 engineering days.

Acceptance:

- Extract provider contract tests that can run against fake host adapters.
- Assert capability negotiation, unsupported-capability rejection, typed errors,
  artifact metadata, and stale-session recovery independently of Playwright.
- Keep existing Playwright tests as the Web provider implementation suite.


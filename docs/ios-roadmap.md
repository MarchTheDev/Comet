# iPhone / iOS feasibility

**Status: investigation only.** The current release is Windows desktop; no iOS app, signed `.ipa`, iPhone build workflow, or mobile sync has been produced or tested. Tauri 2 can target iOS, so GitHub Actions **can eventually build an IPA on a macOS runner with Xcode**, but adding a workflow alone would not make this desktop app usable or distributable on iPhone.

## Main work before building

1. **Platform startup.** Gate or replace the desktop tray, single-instance and autostart plugins, desktop window visibility/size and Windows updater. Check all dependencies and Tauri capabilities against iOS rather than assuming desktop plugins exist on mobile.
2. **Files and safety.** iOS document pickers and the sandbox do not provide the same unrestricted desktop paths. Design access to app-owned storage and explicitly chosen Files locations, including security-scoped access/bookmarks where applicable, backup/import and lifecycle recovery. `rename_without_replace` currently returns unsupported on iOS; safe no-overwrite publication and file operations must be implemented and tested before allowing edits or imports. Do not weaken existing containment, no-overwrite or password-vault guarantees.
3. **Google.** The current desktop OAuth opens the browser and listens on a loopback port. iOS needs an appropriate iOS OAuth client and an approved app/browser callback (such as an iOS authentication session with PKCE), secure Keychain storage and its own redirect configuration. App verification and scopes must be checked for the mobile client. Automatic incremental Drive sync is not implemented on desktop yet and must be designed for iOS suspension/network limits too.
4. **Interaction and lifecycle.** Adapt touch targets, canvas gestures, file selection, media, safe areas, keyboard, screen rotation, accessibility and background/foreground saves. An iOS app may be suspended; never promise continuous background sync without implementing and validating an OS-supported mechanism.
5. **Validation.** Initialize the Tauri iOS/Xcode project only as part of the port. First compile for the simulator and test on real iPhones; then test file persistence, interrupted writes, account authorization, media, password recovery and safe sync/conflicts across devices.

## GitHub Actions and signing

After the app is iOS-ready, a macOS runner can install Node and the Rust Apple targets, select Xcode, build/archive the Tauri iOS project and export an IPA. Distribution requires a unique Apple bundle identifier, appropriate signing identity and provisioning. Store signing material in GitHub Actions secrets or use the supported App Store Connect API-key/automatic-signing route; never commit private keys or certificates to the repo. A simulator build or unsigned archive is **not** a generally installable iPhone IPA.

- TestFlight and App Store distribution require Apple Developer Program membership (Apple currently lists US $99/year, with local pricing potentially different), an App Store Connect app and appropriate signing.
- Ad hoc distribution also needs suitable enrollment/signing and is limited to registered devices in its provisioning profile.
- A free Apple account can support limited personal on-device testing through Xcode, but not TestFlight/App Store distribution; check Apple's current provisioning limits and conditions.

Sources: [Tauri iOS signing](https://v2.tauri.app/distribute/sign/ios/), [Tauri App Store distribution](https://v2.tauri.app/distribute/app-store/), [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/), [Apple membership comparison](https://developer.apple.com/support/compare-memberships/) and [Apple ad hoc provisioning](https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile/).

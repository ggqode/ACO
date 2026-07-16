# Changelog

All notable changes to this project will be documented in this file.

## [1.2.1] - 2026-07-16
### Changed
- **Affiliate Disclosure**: Updated the UI in the popup and cart acceptance overlay to explicitly state that the "Z poleceniem" option uses the Allegro Share affiliate program, in compliance with Chrome Web Store guidelines.

### Fixed
- **Iframe Cart Rebuilding**: Fixed an issue in Chrome where the background cart rebuilding stalled. Added `all_frames: true` to the manifest to ensure the content script is correctly injected into the hidden iframe.

---

## [1.2] - 2026-07-15
### Added
- **Silent Mode Rebuilding**: Cart reconstruction is now done silently in the background via a hidden iframe, making the user's viewport reload-free during item addition.
- **Cart Rechecker & Self-Correction**: Implemented a self-correction loop (`verifyAndCorrectCart`) that compares the rebuilt cart to the planned mathematical optimum, correcting item quantities, removing extra items, and adding missing ones.
- **Pause on Tab Switch**: Scraping automatically pauses when the main Allegro tab is inactive (preventing browser energy-saving timeouts) and resumes immediately upon returning to the tab.

### Changed
- Overlay warnings updated to advise against switching tabs to maintain optimal execution speed.
- Safe Mode is now disabled by default for faster execution.

---

## [1.1.1] - 2026-07-15
### Fixed
- **Unnecessary Permissions**: Removed redundant permissions from manifest files to improve security and extension compliance.

---

## [1.1] - 2026-07-13
### Added
- **Firefox Compatibility**: Implemented full compatibility for Mozilla Firefox browser.
- **Firefox Icon and Asset Packaging**: Added sizing structures to avoid missing icons in Firefox's toolbar and extension manager.

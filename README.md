# extension-crash

Chromium browser extension conflict detector for any page that fails only in a specific browser profile.

The tool reads a Chrome profile, builds a list of enabled extension candidates, then launches a temporary Chrome instance with different extension subsets until it isolates the smallest set that reproduces the failure.

## Why this approach

When a site fails only in one browser profile, the root cause is often:

- an ad blocker or privacy extension rewriting requests
- a wallet or security extension injecting content scripts
- a downloader or page modifier changing headers or DOM state
- an interaction between two extensions

Manual testing is slow. This project automates the process.

## What it does

1. Reads installed extensions from a Chromium profile.
2. Filters to likely user-installed candidates by default.
3. Tests the target URL with:
   - no extensions
   - all candidate extensions
   - smaller subsets chosen by delta debugging
4. Writes a JSON report with every test and the final diagnosis.
5. Can compare two browser profiles to highlight profile-specific storage and extension deltas.

## Supported browsers

- Google Chrome on Windows
- Microsoft Edge on Windows
- Brave on Windows

Chrome is the default.

## Install

```bash
npm install
```

## Quick start

List detected profiles:

```bash
npm run profiles
```

Run the detector against any target page with the default Chrome profile:

```bash
node ./src/cli.js --url "https://example.com" --profile Default
```

Use a specific profile and cap the first run to 8 extensions:

```bash
node ./src/cli.js --url "https://example.com" --profile "Profile 2" --limit 8
```

Include component and externally installed extensions:

```bash
node ./src/cli.js --url "https://example.com" --profile Default --include-all-locations
```

If the blocked page shows a custom message with HTTP 200, add text patterns so the tool can recognize failure:

```bash
node ./src/cli.js --url "https://target-site.example/path" --profile Default --block-pattern "Access Denied" --block-pattern "Reference #"
```

If you know what the healthy page should contain, add success patterns:

```bash
node ./src/cli.js --url "https://target-site.example/path" --profile Default --success-pattern "product" --url-must-contain "target-site.example"
```

Quickly retest only the suspect extensions from a previous report:

```bash
node ./src/cli.js --from-report "./reports/report-1234567890.json"
```

Compare a failing profile against a working one for the same URL:

```bash
node ./src/cli.js --url "https://target-site.example/path" --profile "Profile 2" --compare-profile Default
```

Run doctor mode to compare profiles and get a repair recommendation in one step:

```bash
node ./src/cli.js --url "https://target-site.example/path" --profile "Profile 2" --compare-profile Default --doctor
```

If doctor mode says site data is the problem and Chrome is closed, let it run the repair automatically:

```bash
node ./src/cli.js --url "https://target-site.example/path" --profile "Profile 2" --compare-profile Default --doctor --auto-repair
```

Repair a live profile by clearing cookies and site storage for the target URL origin:

```bash
node ./src/cli.js --url "https://target-site.example/path" --profile "Profile 2" --repair-site-data
```

Retest mode still runs the suspect set even if the no-extension baseline becomes unstable, and notes that condition in the new report.

Retest a specific extension ID directly:

```bash
node ./src/cli.js --url "https://target-site.example/path" --profile Default --extension-id "ooadnieabchijkibjpeieeliohjidnjj"
```

## Output

By default the tool writes a report under `reports/` and prints a short summary to the console.

The detector marks a run as blocked when one of these happens:

- navigation fails entirely
- the main response status is `>= 400`
- Chrome lands on an internal error page
- a configured block pattern matches the title or body text
- a configured success pattern is missing
- a required URL fragment is missing from the final URL

Typical outcomes:

- `single-extension`: one extension alone reproduces the failure
- `interaction`: no single extension fails alone, but a minimal set still fails together
- `not-reproduced`: the page worked both with and without extensions
- `baseline-fails`: the page already fails with no extensions, so automatic isolation is unreliable
- `inconclusive`: the failure pattern changed or could not be minimized cleanly

Profile compare reports also include:

- enabled extension differences between two profiles
- cookie presence and hashed value deltas for the target URL
- localStorage and sessionStorage key/value deltas
- service worker, Cache Storage, and IndexedDB name differences
- a high-level likely-cause summary

Repair reports include:

- the target origins that were cleared
- cookies deleted for the target URL
- before/after page state
- before/after screenshots

Doctor reports include:

- the profile comparison summary
- the recommended next action
- the exact repair command to run
- the repair result if `--auto-repair` was used

## Important limitations

- Chrome must be installed locally.
- The tool launches a fresh temporary browser profile, not your live profile.
- Some extensions behave differently when reloaded from disk into a temporary profile.
- Sites with aggressive bot detection may block automation even without extensions. In that case the report will usually end as `baseline-fails`.
- Profile compare mode works best when Chrome windows using those profiles are closed, so cookies and storage files can be copied cleanly.
- Repair mode modifies the real selected profile. Close all browser windows first, because the command clears the target site's cookies and storage for that profile.

## Recommended workflow

1. Close Chrome windows that use the target profile if possible.
2. Run:

```bash
node ./src/cli.js --url "https://target-site.example/path" --profile Default
```

3. If the report says `single-extension`, disable or remove that extension in the real browser and retest.
4. If the report says `interaction`, disable the whole reported set and re-enable them one by one in the real browser.
5. If the report says `baseline-fails`, rerun with `--block-pattern`, `--success-pattern`, or a different profile, because the site may be blocking automation itself.
6. If you want a quick confirmation run after the first scan, use `--from-report` to retest only the suspicious set.

## Development

```bash
npm test
```

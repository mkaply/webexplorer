# WebExplorer

Firefox WebExtension (MV3) that displays browsing history as a tree. Background event page tracks navigation events; tree.html/tree.js renders the viewer (used in both tab and sidebar).

## Release process

1. Bump `version` in manifest.json
2. Commit and push to main
3. GitHub Actions signs via AMO, updates `updates.json`, creates a GitHub release
4. Always `git pull --rebase origin main` before committing — CI updates `updates.json` on every release

## Testing

Load as temporary addon: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `manifest.json`.

Key test sites and their quirks:
- **Gmail**: Hash-based SPA routing (`#inbox`, `#inbox/FMfcgz...`). Emails should be siblings under inbox, not nested. Dynamic count-badge favicons (data: URIs that change with unread count).
- **Google Sheets/Docs**: URL cleanup adds `#gid=0` after load. Titles arrive late or not at all on reload.
- **Yahoo**: pushState navigation. Back button should reposition, not create duplicates.
- **Bugzilla/Phabricator**: Internal anchor fragments (`#c5`, `#inline-123`) should not create child nodes.
- **Fark**: Outbound redirector (`fark.com/goto/`) with cross-origin delay.

## Known Firefox bugs

- `webNavigation.onCommitted` sometimes reports `transitionType: "link"` for address bar navigations instead of `"typed"` or `"generated"`. Happens on second+ typed URL in same tab. Cannot be worked around without breaking real link clicks.

## Code conventions

- No eslint — the global "run eslint for patches" rule applies only to mozilla-central work
- No build step — plain JS, loaded directly by Firefox
- Diagnostic ring-buffer log (200 entries) persisted to storage.local; mark-and-report UI for structured bug reports

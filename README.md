# WebExplorer

A Firefox extension that displays your browsing history as a tree, showing **how** you got to each page. A tribute to [IBM WebExplorer](https://en.wikipedia.org/wiki/IBM_WebExplorer) (1994), which pioneered this view.

When you click a link that opens in a new tab, the new tab becomes a *child* of the source page. When you click between emails in Gmail, they show up as siblings under your inbox. Back-button navigations reposition within the existing tree instead of creating duplicates. The result is a visual record of how you actually explored the web.

## Install

- Latest signed build: see the [Releases](https://github.com/mkaply/webexplorer/releases) page and click the `.xpi` file. Firefox will prompt to install.
- After install, look for the WebExplorer icon in the toolbar (or in **View → Sidebar → WebExplorer** for the sidebar view).

Automatic updates are handled via this repo — new releases ship to existing installs through Firefox's update mechanism.

## Use

- **Toolbar button**: opens the full tree in a tab.
- **Sidebar**: same tree, persistent alongside your browsing.
- **Click a node**: switches to that tab if it's still open, otherwise opens a new one and parents future navigation under that node.
- **Middle-click / Ctrl-click**: opens in a background tab.
- **Filter box**: live-search by title or URL (matched rows highlight; ancestors stay visible so you keep context).
- **Expand / Collapse**: top-level controls for the whole tree.
- **Per-row ✕**: remove a single entry; its children re-parent to their grandparent.

## Privacy

WebExplorer stores everything locally in your browser's extension storage. **No data is ever sent to a server.** The diagnostic-report feature (see below) copies a JSON blob to your clipboard so you can paste it where you choose — it doesn't transmit anything on its own.

The captured data is URLs, page titles, favicons, and navigation timestamps — the same things your browser already keeps in its history.

## Reporting bugs

WebExplorer has a built-in diagnostic mode for capturing edge cases:

1. Click **Mark** in the header — the cursor changes and the button turns red.
2. Click any tree node that looks wrong; it gets a red outline.
3. Click **Report** to copy a JSON report to your clipboard. The report includes the marked node, its ancestry, siblings, children, and a filtered log of recent navigation decisions.
4. Paste the JSON into the issue.

The report contains URLs and titles from your recent browsing — review it before pasting publicly.

## Build from source

```sh
git clone https://github.com/mkaply/webexplorer
cd webexplorer
```

To load as a temporary add-on for development:

- Open `about:debugging#/runtime/this-firefox` in Firefox
- Click **Load Temporary Add-on…**
- Select `manifest.json`

To produce a signed XPI locally:

```sh
npm install -g web-ext
web-ext sign --channel=unlisted --api-key=<your AMO issuer> --api-secret=<your AMO secret>
```

Releases on `main` are signed automatically via GitHub Actions when `manifest.json`'s version bumps.

## Acknowledgments

The icon is the original IBM WebExplorer favicon, used as homage. WebExplorer (the original) was discontinued in 2001.

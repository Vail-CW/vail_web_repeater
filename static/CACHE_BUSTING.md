# Cache Busting System

This system ensures users automatically get the latest version of JavaScript and CSS files without needing to hard refresh their browsers.

## How It Works

All JavaScript and CSS files in the HTML are loaded with a version parameter:
- `scripts/vail.mjs?v=1.0.0`
- `scripts/events.mjs?v=1.0.0`
- `vail.css?v=1.0.0`
- `dark.css?v=1.0.0`

When you update the version number, browsers will treat these as new files and download them automatically, even if they have the old versions cached.

## Files Using Version Parameters

- **index.html**: vail.mjs, ui.mjs, upcoming-events.mjs, vail.css, dark.css
- **events.html**: events.mjs, vail.css, dark.css
- **version.js**: Contains the current version number (for reference)

## Updating the Version

### Automatic Method (Recommended)

Use the PowerShell script to automatically update all files:

```powershell
.\update-version.ps1 1.0.1
```

This will:
1. Update `version.js` with the new version
2. Update all `?v=` parameters in HTML files
3. Show you what files were updated

### Manual Method

If you prefer to update manually:

1. Open `version.js` and update the version number
2. Open `index.html` and replace all `?v=1.0.0` with `?v=1.0.1`
3. Open `events.html` and replace all `?v=1.0.0` with `?v=1.0.1`

**Important**: Make sure the version is the same in all files!

## Version Numbering

Use semantic versioning (MAJOR.MINOR.PATCH):
- **MAJOR**: Breaking changes or major new features
- **MINOR**: New features, backward compatible
- **PATCH**: Bug fixes, minor changes

Examples:
- `1.0.0` → `1.0.1`: Bug fix (timezone display)
- `1.0.0` → `1.1.0`: New feature (chat history)
- `1.0.0` → `2.0.0`: Major rewrite

## Deployment Workflow

1. Make your changes to JavaScript/CSS files
2. Test locally
3. Run `.\update-version.ps1 <new-version>`
4. Commit changes: `git add . && git commit -m "Bump version to <new-version>"`
5. Deploy to production
6. Users will automatically get the new version on their next page load!

## Why This Works

Browsers cache resources based on their full URL. When the version parameter changes:
- Old: `vail.mjs?v=1.0.0` (cached)
- New: `vail.mjs?v=1.0.1` (different URL, fetched fresh)

The browser sees these as different resources, so it fetches the new one automatically.

## Troubleshooting

**Problem**: Users still seeing old version after update
**Solution**: Make sure you updated the version in BOTH HTML files

**Problem**: Some files updated but not others
**Solution**: Check that all files have the same version number

**Problem**: Service worker still serving old files
**Solution**: The service worker already uses `cache: "no-cache"` for JS/CSS, but you can clear it in browser DevTools → Application → Service Workers → Unregister

## Best Practices

1. **Always update the version** when deploying changes to JS/CSS files
2. **Use the script** to avoid typos and ensure consistency
3. **Test locally first** before deploying
4. **Document changes** in your commit messages
5. **Increment appropriately** based on the type of change

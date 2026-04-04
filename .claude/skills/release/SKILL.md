---
name: release
description: Bump version, build, test, publish to npm, tag and create GitHub release
user_invocable: true
---

# Release @else42/cf-worker-otel

Publish a new version to npmjs.com and create a GitHub release (which triggers the GitHub Packages publish via CI).

## Steps

### 1. Determine version bump

- Check current version: read `package.json` → `version`
- Check latest git tag: `git tag --sort=-v:refname | head -1`
- Review changes since last tag: `git log <last-tag>..HEAD --oneline`
- Decide bump level (patch/minor/major) based on conventional commits:
  - `fix:` → patch
  - `feat:` → minor
  - `feat!:` or `BREAKING CHANGE:` → major
- Confirm with user before proceeding

### 2. Bump version

```bash
npm version <patch|minor|major>
```

This updates `package.json` and creates a git tag.

### 3. Build and test

```bash
npm run build
npm test
npm run check
```

All must pass. If anything fails, stop and fix before continuing.

### 4. Push

```bash
git push && git push --tags
```

### 5. Publish to npmjs.com

```bash
npm publish --access public --registry https://registry.npmjs.org
```

This will open a browser for passkey authentication. Ask the user to complete auth via `!` prefix if needed.

### 6. Create GitHub release

```bash
gh release create v<VERSION> --title "v<VERSION>" --notes "<release notes>"
```

Release notes format:
```markdown
## What's Changed

- <description of changes from git log>

**Full Changelog**: https://github.com/elsbrock/cf-worker-otel/compare/v<PREV>...v<NEW>
```

The GitHub release triggers the CI workflow which publishes to GitHub Packages automatically.

### 7. Verify

- Check npmjs: `npm view @else42/cf-worker-otel version`
- Check GitHub Packages: `gh api '/users/elsbrock/packages/npm/cf-worker-otel/versions' --jq '.[0].name'`

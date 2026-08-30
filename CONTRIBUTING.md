# Contributing

HdrToSdr is a **source-alpha** macOS project. Binary releases are currently
disabled. Keep changes focused and do not add user media, secrets, local tool
binaries, or generated build output.

## Local checks

Use Node 22.12+ and Python 3.10+:

```bash
npm ci
npm run guard:repo
npm audit --audit-level=high
npm run check
git diff --check
```

The following commands are exact, optional local gates and are not part of
`npm run check` or normal CI:

```bash
npm run doctor
npm run test:media:integration
npm run test:resolve:headless
npm run bundle:resolve
```

The first three require locally installed Resolve, media, or repo-local tools;
the bundle command is a portability/release check. Do not download tools or
commit their outputs as part of a source change.

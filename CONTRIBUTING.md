# Contributing to ADHDev

Thank you for your interest in contributing to ADHDev! 🦦

## 🔌 Adding a New Provider

**Are you looking to add support for a new IDE, CLI, or ACP agent?**

Providers live in the external [vilmire/adhdev-providers](https://github.com/vilmire/adhdev-providers) repository. The daemon automatically downloads these providers on startup and mirrors the category-based structure in your local `~/.adhdev/providers/` directory.

👉 Start with the [Provider Contribution Guide](https://github.com/vilmire/adhdev-providers/blob/main/CONTRIBUTING.md) in the providers repository.

For a deeper walkthrough, see the provider guide on [docs.adhf.dev](https://docs.adhf.dev/features/providers).

---

## 🛠️ Contributing to ADHDev Core

If you want to contribute to the core ADHDev engine (the daemon, the web dashboard, or the DevConsole), you are in the right place!

### Development Setup

```bash
git clone https://github.com/vilmire/adhdev.git
cd adhdev
npm install

# Build packages (order matters — dependencies first)
npm run build -w packages/daemon-core
npm run build -w packages/web-core
npm run build -w packages/web-standalone
npm run build -w packages/daemon-standalone

# Run the daemon (dashboard at http://localhost:3847)
node packages/daemon-standalone/dist/index.js

# Or use dev mode (Vite hot-reload for dashboard)
npm run dev
```

### 📁 Project Structure

```
packages/
├── daemon-core/        # Core engine — CDP, providers, commands, lifecycle
├── daemon-standalone/  # Self-hosted HTTP/WS server (localhost:3847)
├── web-core/           # Shared React components, pages, CSS design system
├── web-standalone/     # Standalone React dashboard (Vite + React)
└── web-devconsole/     # DevConsole — provider debugging tools
```

#### Key Source Files

| Package | Key File | Purpose |
|---------|----------|---------|
| `daemon-core` | `src/boot/daemon-lifecycle.ts` | `initDaemonComponents()` / `shutdownDaemonComponents()` |
| `daemon-core` | `src/cdp/initializer.ts` | `DaemonCdpInitializer` — multi-IDE CDP management |
| `daemon-core` | `src/commands/router.ts` | `DaemonCommandRouter` — unified command routing |
| `daemon-core` | `src/providers/provider-loader.ts` | `ProviderLoader` — load/update provider.js |
| `daemon-standalone` | `src/index.ts` | HTTP/WS server + lifecycle integration |
| `web-core` | `src/pages/Dashboard.tsx` | Main dashboard page |

### 🏗️ Build Order

Packages must be built in dependency order:

```
1. daemon-core       (no internal dependencies)
2. web-core          (no internal dependencies)
3. web-standalone    (depends on web-core)
4. daemon-standalone (depends on daemon-core)
5. web-devconsole    (depends on daemon-core)
```

### 🧪 Testing

```bash
# Type-check (no emit)
npx tsc --noEmit -p packages/daemon-core/tsconfig.json
npx tsc --noEmit -p packages/daemon-standalone/tsconfig.json

# Run standalone daemon
node packages/daemon-standalone/dist/index.js
# Dashboard at http://localhost:3847

# Verify the build
head -1 packages/daemon-standalone/dist/index.js | grep '#!/usr/bin/env node'
```

### 📝 Code Style

- TypeScript strict mode
- Prefer explicit types over `any` — use `unknown` for generic data, cast with type guards
- JSDoc comments on public interfaces and exported functions
- Use standard React hooks for the frontend (no class components)

### 🔄 Development Workflow

1. **Fork** the repository and create a branch: `git checkout -b feat/my-new-feature`
2. **Implement** your changes in the appropriate package.
3. **Build** affected packages in dependency order.
4. **Test** by running the standalone daemon locally.
5. **Submit a PR** to the `main` branch.

### ❓ Need Help?

If you find a bug or have a feature request for the core engine, please open an Issue.

## 📜 Contributor License Agreement (CLA)

Before your Pull Request can be merged, you must sign our [CLA](./CLA.md).

When you open a PR, a bot will automatically prompt you. Reply with:

> I have read the CLA Document and I hereby sign the CLA

This is a one-time step that allows ADHDev to distribute your contribution under both AGPL-3.0 and commercial licenses.

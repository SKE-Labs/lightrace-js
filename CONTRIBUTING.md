# Contributing to lightrace-js

Thank you for your interest in contributing!

## Development Setup

### Prerequisites

- Node.js 20+
- Yarn 1.22+

### Quick Start

```bash
git clone https://github.com/nichochar/lightrace-js.git
cd lightrace-js
yarn install
```

### Commands

```bash
yarn test           # Run tests
yarn test:watch     # Run tests in watch mode
yarn typecheck      # TypeScript type check
yarn lint           # ESLint
yarn lint:fix       # ESLint with auto-fix
yarn format         # Prettier format
yarn format:check   # Prettier check
yarn build          # Build to dist/
```

## Code Quality

### Pre-commit Hooks

Husky runs automatically on commit:

- **Pre-commit**: `lint-staged` (Prettier on staged files)
- **Pre-push**: `tsc --noEmit` (TypeScript check)

### Style Guide

- **Prettier** for formatting (100 char width, double quotes, trailing commas)
- **ESLint** with `typescript-eslint` recommended rules
- Avoid `any` type when possible (warnings, not errors)
- Use `unknown` with type guards instead

### Testing

We use **Vitest** for testing. Tests live in `tests/`.

```bash
# Run all tests
yarn test

# Run specific test file
yarn vitest run tests/trace.test.ts
```

## Pull Requests

1. Fork the repo and create a feature branch
2. Write tests for new functionality
3. Ensure `yarn test`, `yarn typecheck`, and `yarn lint` pass
4. Submit a PR with a clear description

## Release Process

Releases are automated via GitHub Actions. Maintainers trigger the release workflow which handles versioning, building, and npm publishing.

## License

MIT

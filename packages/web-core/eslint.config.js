import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      // RF-P2 #5 barrel guard: the web layer must NOT pull runtime values from the
      // '@adhdev/daemon-core' root barrel. A value import drags the entire daemon-core
      // engine (node-pty, better-sqlite3, etc.) into the web bundle — this is what the
      // normalizeManagedStatus root-barrel export once did and took production down.
      // Type-only imports are safe (erased at compile time) and stay allowed.
      // Runtime values must come from an explicit subpath export instead, e.g.
      //   import { normalizeManagedStatus } from '@adhdev/daemon-core/status/normalize'
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: [
          {
            name: "@adhdev/daemon-core",
            allowTypeImports: true,
            message:
              "The '@adhdev/daemon-core' root barrel is type-only in the web layer. Import runtime values from a subpath export (e.g. '@adhdev/daemon-core/status/normalize') so the whole daemon-core engine is not bundled into the web build (RF-P2 #5 barrel guard).",
          },
        ],
      }],
    },
  }
);

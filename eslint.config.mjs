import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExportDefaultDeclaration",
          message: "No default exports (only src/main.ts, required by Obsidian).",
        },
      ],
      "no-restricted-exports": ["error", { restrictedNamedExports: ["default"] }],
      "max-lines": ["error", { max: 300, skipBlankLines: false }],
    },
  },
  {
    // Obsidian requires a default export from the entry; tool configs do too.
    files: ["src/main.ts", "*.config.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);

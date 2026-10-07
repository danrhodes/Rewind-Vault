import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-exports": ["error", { restrictedNamedExports: ["default"] }],
      "max-lines": ["error", { max: 300, skipBlankLines: false }],
    },
  },
);

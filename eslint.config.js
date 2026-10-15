import globals from "globals";

export default [
  {
    files: ["web-capture/js/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.browser } },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
  },
  {
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-import-assign": "error",
      "no-dupe-keys": "error",
      "no-redeclare": "error",
      "no-const-assign": "error",
      "no-unreachable": "warn",
      "eqeqeq": ["warn", "smart"],
    },
  },
];

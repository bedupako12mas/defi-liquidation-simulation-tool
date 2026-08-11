import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "dist/**",
      "lib/api/mock/fixtures.generated.json",
    ],
  },
];

export default eslintConfig;

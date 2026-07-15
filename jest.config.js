module.exports = {
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  collectCoverageFrom: [
    "roborockLib/**/*.js",
    "!roborockLib/lib/sniffing/**",
    "!roborockLib/lib/map/**",
  ],
};

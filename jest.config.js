module.exports = {
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  // Jest's default is 5 s, and a handful of tests here do REAL I/O — spawning
  // a Node child, connecting a TCP socket to a closed port — so their cost is
  // an OS operation rather than a function call. Under full-suite load those
  // cross 5 s at random: measured 27 Aug 2026, three consecutive full runs
  // each failed a DIFFERENT one of them, while every one of those files passed
  // on its own in under ten seconds. That made the release gate a coin flip,
  // which either blocks a good release or trains whoever reads it to wave red
  // through — and the second is the worse failure.
  //
  // 20 s is ~220× the suite's mean test and far above any correct test here,
  // so a test that reaches it is genuinely stuck rather than merely unlucky.
  // Individual real-I/O tests still set their own higher ceiling where a cold
  // interpreter start is involved.
  testTimeout: 20_000,
  collectCoverageFrom: [
    "roborockLib/**/*.js",
    "!roborockLib/lib/sniffing/**",
    "!roborockLib/lib/map/**",
  ],
};

export default {
  testEnvironment: 'node',
  collectCoverageFrom: ['src/**/*.js'],
  coveragePathIgnorePatterns: ['/server.js$'],
  coverageThreshold: {
    global: { branches: 50, functions: 50, lines: 50, statements: 50 }
  },
  setupFilesAfterEnv: ['./tests/jest.setupAfterEnv.js'],
  openHandlesTimeout: 5000,
  // Some suites leave Redis/BullMQ connections open; without this Jest never exits and CI hangs until the job timeout.
  forceExit: true,
};

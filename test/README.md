# Supervisor Testing

The supervisor is a system controller for Balena devices, as such it needs to be able to keep working even without Internet access, without user intervention, and recover in the case of failures. Additionally the supervisor is the main interface between the balenaCloud API and balenaOS, meaning it is a critical piece of the stack that enables Balena users to manage their fleets of IoT devices.

Automated testing is what ensures that the Supervisor continues to work properly according to its specifications, and enables supervisor developers to make changes to the codebase and introduce new features with confidence. Because we cannot rely on users to be running the latest release of the Supervisor on their devices, bugs tend to stick around for a long time, causing troubles for Balena users and additional load on support agents. This is yet another reason for ensuring that code is tested as thoroughly as possible.

## The tests

This folder contains the Supervisor test suites and configurations.

- [./lib](./lib) constains test utils common to all tests.
- [./data](./data) contains test data files to be used in supervisor tests. Tests must not directly modify the data in this folder, but make copies of it to temporary folders or to memory (**WIP**).
- [./legacy](./legacy) contains the current test suite for the supervisor. These files are being classified between unit and integration tests and improved whenever possible. This folder will eventually dissapear. **DO NOT ADD NEW TESTS TO THIS FOLDER**.
- [./unit](./unit) contains the suite of unit tests for the supervisor. A unit test is a test that meets the following requirements: 1. verifies a single unit of behavior, 2. does it quickly, 3. does it in isolation from other tests. Unit tests in general are reserved for the domain model and algorithms.
- [./integration](./integration) contains the integration tests for the supervisor. An integration test is anything that is not a unit test. An integration test generally will test code that interacts with out-of-process dependencies (the filesystem, a database, external APIs). The way the tests interact with these external dependencies depends on whether these dependencies are completely under the control of the system under test (managed) or if they interact with other systems (unmanaged). Managed dependencies can be setup by the test, e.g. an in-memory version of the supervisor database can be setup before the test and cleared after the test. Unmanaged dependencies (or dependencies that are too slow to setup) need to be mocked.

## Other considerations

- Tests need to make the code easy to refactor, this means:
  - only the observable behavior of the system under test (function/class/module) should be tested,
  - tests should NOT rely on implementation details of the system under test, i.e. the function/class/module needs to be treated as a black box, and
  - only test public interfaces of the classes/modules.

If the test does not meet the above requirements, that means that changes in the code will require changing the test, making the test suite less reliable.

- Test should work in isolation of each other. This means the tests should be able to run in any order with the same outcome. A test leaking data to another test makes the test suite less reliable.

- [Mocking is a code smell](https://medium.com/javascript-scene/mocking-is-a-code-smell-944a70c90a6a). The need to mock too many dependencies to achieve test isolation is a sign of tight coupling in the code, which means the code needs to be refactored. Tight coupling makes the code more difficult to refactor, which is another reason to avoid it.

For more information on good testing practices, look into [Unit Testing Principles, Practices and patterns](https://www.manning.com/books/unit-testing). Many of the references in this document have been taken verbatim from there.

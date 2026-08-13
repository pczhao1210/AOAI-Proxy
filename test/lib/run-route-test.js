import { withTestContext } from "./harness.js";
import { getRouteTest, routeTests } from "./route-definitions.js";

export async function runRouteTestById(id) {
  const routeTest = getRouteTest(id);
  if (!routeTest) {
    throw new Error(`Unknown route test: ${id}`);
  }

  await withTestContext(async (ctx) => {
    await routeTest.run(ctx);
  }, { logLevel: routeTest.logLevel });

  process.stdout.write(`PASS ${routeTest.id} ${routeTest.description}\n`);
}

export async function runRouteTestBatch() {
  const tests = routeTests;
  for (const routeTest of tests) {
    await runRouteTestById(routeTest.id);
  }
}
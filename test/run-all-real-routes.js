import {
  runRealBlackforestImageTest,
  runRealChatCompletionTest,
  runRealOpenAiImageTest,
  runRealResponseTest
} from "./lib/real-model-test.js";

await runRealChatCompletionTest();
await runRealResponseTest();
await runRealOpenAiImageTest();
await runRealBlackforestImageTest();
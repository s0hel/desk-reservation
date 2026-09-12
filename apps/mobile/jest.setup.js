// Reanimated ships a Jest mock; gesture-handler needs its setup imported once.
require("react-native-gesture-handler/jestSetup");

// Quieten the animation frame warnings that reanimated emits under fake timers.
jest.spyOn(global.console, "warn").mockImplementation((...args) => {
  const message = String(args[0] ?? "");
  if (message.includes("[Reanimated]")) return;
  console.info(...args);
});

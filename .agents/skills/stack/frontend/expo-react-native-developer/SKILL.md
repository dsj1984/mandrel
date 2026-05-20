---
name: expo-react-native-developer
description:
  Prevents DOM element usage in React Native (Expo) workspaces. Use when
  writing components for Expo apps — `<View>`, `<Text>`, `<TouchableOpacity>`
  instead of `<div>`/`<span>`/`<p>`, no `window`/`document`, and styling
  through the project's established solution.
vendor: expo
---

# Expo React Native Developer

## Policy Capsule

- Never use HTML DOM elements (`<div>`, `<span>`, `<p>`, `<button>`, etc.) inside Expo or React Native components.
- Use React Native primitives instead: `<View>`, `<Text>`, `<TouchableOpacity>`, `<Pressable>`, `<ScrollView>`.
- Never reference browser globals (`window`, `document`, `localStorage`) in React Native code paths.
- Route all styling through the project's established styling solution; do not introduce a parallel CSS pipeline.
- Treat the `@repo/mobile` workspace as DOM-free — any DOM symbol that appears is a hallucination and must be replaced.

**Description:** Prevents DOM element usage in React Native.

**Instruction:** For the `@repo/mobile` workspace:

- YOU MUST NOT use HTML DOM elements like `<div>`, `<span>`, or `<p>`.
- Use strict React Native primitives: `<View>`, `<Text>`, `<TouchableOpacity>`,
  etc.
- Ensure all styling uses the established styling solution.
- Never use `window` or `document` objects.

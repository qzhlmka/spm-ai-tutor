import type { AppConfig } from "./types";

// The platform isn't scoped to one subject — this is just static branding/copy,
// not a filter passed to the backend.
export const appConfig: AppConfig = {
  // Deliberately NOT "Ask me anything" — student testing found that framing set
  // an expectation of unlimited capability, which the tutor's SPM-only scope
  // then refused. Naming the scope up front is the fix they asked for.
  inputPlaceholder: "Ask me any SPM question...",
};

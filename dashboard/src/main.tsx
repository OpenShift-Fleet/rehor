import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@patternfly/patternfly/patternfly.css";
import "@patternfly/patternfly/patternfly-addons.css";
import App from "./App";
import "./App.css";
import ErrorBoundary from "./components/ErrorBoundary";
import { applyStoredTheme } from "./utils/applyStoredTheme";

applyStoredTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

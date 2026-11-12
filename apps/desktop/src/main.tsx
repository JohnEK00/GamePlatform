import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@webgame/ui/style.css";
import "./desktop.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

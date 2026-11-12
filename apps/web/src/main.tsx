import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WebGameApp } from "@webgame/ui";
import "@webgame/ui/style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WebGameApp config={{ apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "", routerMode: "browser" }} />
  </StrictMode>,
);

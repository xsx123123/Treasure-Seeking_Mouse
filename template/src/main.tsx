// 应用入口：样式在 ./styles.css（Tailwind v4 + design token），页面在 ./routes/index.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { ChatPage } from "./routes/index";
import { I18nProvider } from "./i18n/provider";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <ChatPage />
    </I18nProvider>
  </React.StrictMode>
);
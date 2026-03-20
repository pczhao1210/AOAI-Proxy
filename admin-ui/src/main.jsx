import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "react-hot-toast";
import App from "./App.jsx";
import { I18nProvider } from "./i18n.jsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <I18nProvider>
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: "var(--panel-strong)",
            color: "var(--ink)",
            border: "1px solid var(--line)",
            maxWidth: "min(92vw, 720px)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflowWrap: "anywhere"
          }
        }}
      />
      <App />
    </I18nProvider>
  </React.StrictMode>
);
